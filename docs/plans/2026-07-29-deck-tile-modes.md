# Stream Deck Tile-Style Setting + Strip Waiting-Count Union Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Add a persisted user setting choosing between the new "Status icons" deck tile style (default; what `feat/deck-tile-redesign` built) and the classic "Terminal previews" style (restored from git history and gated behind the setting), and make the Stream Deck+ touch-strip "waiting" count the union of needs-attention and waiting-for-approval tabs in both styles.

**Architecture:** Client-only. The new `streamDeck.tileStyle` setting lives in `LocalSettings` (localStorage persist, sparse-diff pattern) and flows into `selectDeckModel`, which carries it on `DeckModel` — so the controller's model-JSON bail-out and per-key spec-JSON paint cache invalidate automatically on a style switch (live repaint + re-sort, no reload). `KeySpec`'s tab variant becomes a two-member union discriminated on a `style` field (`'icons'` | `'preview'`); `buildFrame` constructs one or the other per the model's `tileStyle`, and the renderer dispatches on it. The classic machinery (terminal-text registry, preview polling, ring rendering) is restored verbatim from this branch's own git history and only ever executes when `tileStyle === 'terminal-previews'`. A new always-computed `DeckTab.pendingApproval` flag (restored `tabHasPendingApproval`) feeds both the classic amber ring and the strip's new union waiting count.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest (jsdom, fake-transport "e2e"), Tailwind, Zod (settings validation), Canvas 2D via injectable `CtxFactory`.

## Global Constraints

- Work in the worktree `/home/dan/code/freshell/.worktrees/deck-tile-modes` on branch `feat/deck-tile-modes` (based on `feat/deck-tile-redesign`, NOT origin/main). The eventual single PR contains the redesign plus this work.
- Do NOT create or open a PR without explicit user approval. Committing and pushing the branch is fine; stop before `gh pr create`.
- NEVER restart the live Rust/freshell server on port 3002. No broad kill patterns (`pkill -f vite`, `pkill node`, etc.).
- Client-only: no `server/` changes. Do NOT touch `/api/panes/:id/capture` or `server/agent-api/capture.ts`.
- The tab bar (`TabBar.tsx`, `TabItem.tsx`) must remain visually and behaviorally unchanged.
- Red-Green-Refactor TDD for every task. `console.error` is FATAL under test (`test/setup/dom.ts` throws) — no code path may log errors in tests.
- Focused test runs: `npm run test:vitest -- run <path> --config config/vitest/vitest.config.ts` (`--config` is mandatory; there is no root vitest config). Broad runs (`npm test`, `npm run check`) go through the shared coordinator — check `npm run test:status` first and never kill a foreign holder.
- Lint: `npm run lint` (includes eslint-plugin-jsx-a11y; CI requirement). Typecheck: `npm run typecheck:client`.
- jsdom has no canvas and never loads images: renderer tests inject fake `Ctx2D`/loaders; controller/e2e tests use spec-encoding renderers (`encodeSpec`/`decodeKey`). Never add `environmentOptions.jsdom.resources` to the vitest config.
- Commits: Conventional Commits with `(deck)` scope where applicable, lowercase imperative subject, one focused commit per task.
- Path aliases: `@/` → `src/`, `@test/` → `test/`.
- Setting values are exactly `'status-icons'` (label **Status icons**, the default) and `'terminal-previews'` (label **Terminal previews**).
- README.md is the only end-user markdown doc to touch (plus this plan). `docs/index.html` is NOT updated: the default experience is unchanged (default style = the redesign), and a settings enum is not a "major change" per AGENTS.md's bar.

## Design Decisions (settled — do not re-litigate)

1. **`tileStyle` rides on `DeckModel` and `KeySpec`.** The controller's repaint bail-out is `JSON.stringify(selectDeckModel(state))` (`deck-controller.ts:196-199`) and the per-key paint cache is `JSON.stringify(spec)` (`deck-controller.ts:137-143`). Putting the style in the model and giving the tab KeySpec a `style` discriminant makes a settings flip repaint every key with zero extra invalidation machinery.
2. **Sort is gated in `selectDeckModel`:** `'status-icons'` sorts by `tilePriority`; `'terminal-previews'` keeps raw tab-bar order (the pre-redesign behavior). Paging, dials, and press targeting are order-agnostic downstream.
3. **Capture polling is gated in the controller's `tick()`** on `this.settings().tileStyle === 'terminal-previews'`. `buildFrame` only calls `previewFor` when building preview-style specs, so the icons style performs zero xterm buffer reads and zero preview repaints.
4. **The registry write side (`useTerminalTextRegistration` in `TerminalView`) is restored un-gated.** Registration is pull-based — a registered closure costs nothing until the controller reads it — and leaving it always-on keeps the module-level registry coherent when the setting flips mid-session. (This mirrors the pre-redesign wiring exactly.)
5. **`DeckTab` gains `pendingApproval: boolean`** (restored `tabHasPendingApproval`), computed in both styles because the strip union needs it everywhere. The classic amber ring derives from it via restored `ringColor({ busy, green: attention, amber: pendingApproval })`. Note: the classic ring's green input is the model's existing `attention` flag (gated on `tabAttentionStyle !== 'none'`, like everything else on the branch) rather than the pre-redesign ungated `attentionByTab` read — a deliberate, tiny unification so both styles honor the user's attention-style preference consistently.
6. **Strip waiting count = `attention || pendingApproval`, counted once per tab, in both styles** (the strip is shared; `stripText` does not branch on style).
7. **`SegmentedControl` gets a one-time a11y upgrade** (optional `aria-label` group name, `role="group"`, `type="button"`, `aria-pressed`) rather than per-callsite hacks — AGENTS.md requires "complex widgets: aria-pressed where applicable", and the control has 3+ existing call sites that inherit the fix for free.

## Restore Points (git archaeology — recover, don't rewrite)

All removed classic machinery exists in this branch's own history. Fork point `62fa0ff1` has the full pre-redesign implementation; `ef52f334` ("remove terminal preview machinery and status rings") and `fb09f7e3` (controller preview-repaint removal) are the deleting commits; `39b9eff8` removed `tabHasPendingApproval`.

```bash
git show ef52f334^:src/deck/terminal-text-registry.ts                    # whole deleted file
git show ef52f334^:test/unit/client/deck/terminal-text-registry.test.tsx # whole deleted test file
git show 62fa0ff1:src/deck/tile-renderer.ts        # old drawTab (preview + banner + rings), preview consts, previewGeometry, cropPreviewLines, RING_COLORS
git show ef52f334^:src/deck/frame.ts               # RingColor, ringColor(), previewLines+ring on KeySpec, FrameInputs.previewFor
git show fb09f7e3^:src/deck/deck-controller.ts     # PREVIEW_REFRESH_TICKS, tickCount, previewFor(), tick() repaint branch
git show 39b9eff8^:src/deck/deck-selectors.ts      # tabHasPendingApproval verbatim
git show ef52f334^:src/components/TerminalView.tsx # useTerminalTextRegistration import + call site
git show 62fa0ff1:test/e2e/stream-deck-flow.test.tsx # old 'titles, previews, and rings' e2e
```

Do NOT `git apply -R` the removal commits: `fb09f7e3` bundles the IconImageCache/repo-icon-probe work you must keep. Hand-merge the quoted pieces.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `shared/settings.ts` | Modify | `DeckTileStyle` type + values + Zod schema; `streamDeck.tileStyle` in type, defaults, patch normalizer, and every resolve/compose/seed site that handles the other streamDeck fields |
| `src/store/browserPreferencesPersistence.ts` | Modify (~:145) | persist `tileStyle` via `assignChangedScalar` |
| `src/components/settings/settings-controls.tsx` | Modify (~:56-83) | `SegmentedControl` a11y upgrade (`aria-label`, `role="group"`, `type="button"`, `aria-pressed`) |
| `src/components/settings/StreamDeckSettings.tsx` | Modify | new "Tile style" `SettingsRow` + `SegmentedControl` |
| `src/deck/terminal-text-registry.ts` | **Restore** (deleted file) | preview registry: `registerTerminalTextReader`, `getTerminalTextSnapshot`, `readXtermTail`, `useTerminalTextRegistration` |
| `src/components/TerminalView.tsx` | Modify | restore `useTerminalTextRegistration(terminalContent?.terminalId, termRef)` call + import |
| `src/deck/deck-selectors.ts` | Modify | restore `tabHasPendingApproval`; `DeckTab.pendingApproval`; `DeckModel.tileStyle`; conditional sort |
| `src/deck/frame.ts` | Modify | `RingColor` + `ringColor()` restored; tab `KeySpec` split into `style: 'icons'`/`'preview'` variants; `FrameInputs.previewFor`; `buildFrame` branches; `stripText` union count |
| `src/deck/tile-renderer.ts` | Modify | restore preview constants, `previewGeometry`, `cropPreviewLines`, `RING_COLORS`, classic draw path (`drawPreviewTab`); dispatch on `spec.style` |
| `src/deck/deck-controller.ts` | Modify | settings thunk type gains `tileStyle`; restore `PREVIEW_REFRESH_TICKS`, `tickCount`, `previewFor()`, gated `tick()` repaint; pass `previewFor` to `buildFrame` |
| `README.md` | Modify (line 35, section lines 68-93) | fix stale copy; document both tile styles + the setting |
| `test/unit/shared/settings.stream-deck.test.ts` | Modify | tileStyle defaults/round-trip/invalid-drop |
| `test/unit/client/components/settings/StreamDeckSettings.test.tsx` | Modify | Tile style control behavior + a11y |
| `test/unit/client/deck/terminal-text-registry.test.tsx` | **Restore** (deleted file) | registry unit coverage |
| `test/unit/client/deck/deck-selectors.test.ts` | Modify | `pendingApproval` flag (restores the lost amber coverage), `tileStyle` on model, sort gating |
| `test/unit/client/deck/frame.test.ts` | Modify | `ringColor` priority (restored), dual-variant `buildFrame`, `previewFor` laziness, strip union |
| `test/unit/client/deck/tile-renderer.test.ts` | Modify | restored `previewGeometry`/`cropPreviewLines` describes, classic tab draw (preview text + ring geometry), icons path regression |
| `test/unit/client/deck/deck-controller.test.ts` | Modify | polling gated by style (both directions), settings fixtures gain `tileStyle` |
| `test/e2e/stream-deck-flow.test.tsx` | Modify | classic journey (previews + rings + tab-bar order), live style switch, no-polling proof, strip union, mid-press style flip |

**Interfaces produced (used across tasks — exact names):**

```ts
// shared/settings.ts
export const DECK_TILE_STYLE_VALUES = ['status-icons', 'terminal-previews'] as const
export type DeckTileStyle = (typeof DECK_TILE_STYLE_VALUES)[number]
// LocalSettings['streamDeck'] gains: tileStyle: DeckTileStyle   (default 'status-icons')

// src/deck/deck-selectors.ts
export type DeckTab = {
  id: string; title: string; active: boolean
  busy: boolean; attention: boolean
  pendingApproval: boolean                    // NEW
  fill: TileFill; dot: TileDot; priority: number
  repoIcons: TileRepoIcon[]
}
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null; tileStyle: DeckTileStyle } // tileStyle NEW
export function tabHasPendingApproval(state: RootState, tabId: string): boolean // RESTORED

// src/deck/frame.ts
export type RingColor = 'amber' | 'green' | 'blue' | null  // RESTORED
export function ringColor(status: { busy: boolean; green: boolean; amber: boolean }): RingColor // RESTORED
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; style: 'icons'; tabId: string; title: string; active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }
  | { kind: 'tab'; style: 'preview'; tabId: string; title: string; active: boolean; previewLines: string[]; ring: RingColor }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
// FrameInputs gains: previewFor: (tabId: string) => string[]

// src/deck/terminal-text-registry.ts (RESTORED verbatim)
export function registerTerminalTextReader(terminalId: string, reader: () => string[]): () => void
export function getTerminalTextSnapshot(terminalId: string): string[] | null
export function resetTerminalTextRegistryForTests(): void
export function readXtermTail(term: XtermLike, maxLines: number): string[]
export function useTerminalTextRegistration(terminalId: string | undefined, termRef: MutableRefObject<XtermLike | null>, maxLines?: number): void

// src/deck/deck-controller.ts
export const PREVIEW_REFRESH_TICKS = 6 // RESTORED (previews re-checked every 3s of TICK_MS=500 ticks)
// DeckControllerOptions.settings: () => { brightness: number; idleBrightness: number; idleTimeoutSeconds: number; tileStyle: DeckTileStyle }

// src/deck/tile-renderer.ts (RESTORED exports)
export const RING_COLORS: Record<Exclude<RingColor, null>, string>
export function previewGeometry(width: number, height: number): { lines: number; columns: number }
export function cropPreviewLines(lines: string[], maxLines: number, maxColumns: number): string[]

// src/components/settings/settings-controls.tsx
// SegmentedControl props gain: 'aria-label'?: string
```

---

### Task 1: `tileStyle` setting — shared schema + localStorage persistence

**Files:**
- Modify: `shared/settings.ts` (type ~:223, defaults ~:895, patch normalizer ~:631-648, plus every other site that handles streamDeck fields — find them all with the grep in Step 1)
- Modify: `src/store/browserPreferencesPersistence.ts:145-155`
- Test: `test/unit/shared/settings.stream-deck.test.ts`

**Interfaces:**
- Consumes: existing `LocalSettings`, `defaultLocalSettings`, `LocalSettingsPatch`, `assignChangedScalar`, the Zod-enum idiom at `shared/settings.ts:546-548` (`TabAttentionStyleSchema`).
- Produces: `DECK_TILE_STYLE_VALUES`, `DeckTileStyle`, `LocalSettings['streamDeck'].tileStyle` (default `'status-icons'`), persisted sparse-diff key. Every later task reads `state.settings.settings.streamDeck.tileStyle`.

- [ ] **Step 1: Map every streamDeck touch point**

Run: `grep -n "idleTimeoutSeconds" shared/settings.ts src/store/browserPreferencesPersistence.ts`

Every line that mentions `idleTimeoutSeconds` is a site the new `tileStyle` field must also be added to (type, defaults, patch normalizer, resolve/compose/seed helpers around `shared/settings.ts:1298/:1389/:1451`, persistence builder). Keep the list; the round-trip test in Step 2 fails until all are covered.

Three of these sites are **explicit string whitelists that silently drop unknown streamDeck keys** (verified): the `pickKeys(raw.streamDeck, ['enabled','brightness','idleBrightness','idleTimeoutSeconds'])` list in `extractLegacyLocalSettingsSeed` (`shared/settings.ts` ~:1451-1456), the identical list in `normalizeExtractedLocalSeed` (~:631-648), and the per-field `buildLocalSettingsPatch` streamDeck section (`browserPreferencesPersistence.ts:145-152`). Missing any of them means `tileStyle` is stripped with no compile error — `updateSettingsLocal` dispatches silently no-op and cross-window sync never carries the field. The grep above catches all three; treat them as mandatory, not optional. (Cross-window note, verified: with these sites covered and `tileStyle` on `DeckModel` (Task 4), a style change in one browser window reaches a deck led by another window live via the existing `crossTabSync` receive path — no new sync machinery is needed; latency is the persistence layer's ~500 ms debounce.)

- [ ] **Step 2: Write the failing tests**

Add to `test/unit/shared/settings.stream-deck.test.ts` (follow the file's existing imports/fixtures; it already tests defaults, resolve→`buildLocalSettingsPatch` round-trips, and the no-patch-at-defaults rule):

```ts
describe('streamDeck.tileStyle', () => {
  it('defaults to status-icons', () => {
    expect(defaultLocalSettings.streamDeck.tileStyle).toBe('status-icons')
  })

  it('round-trips terminal-previews through patch normalization and persistence', () => {
    const normalized = normalizeLocalSettingsPatch({ streamDeck: { tileStyle: 'terminal-previews' } })
    expect(normalized.streamDeck?.tileStyle).toBe('terminal-previews')
    const local = resolveLocalSettings(normalized)
    expect(buildLocalSettingsPatch(local).streamDeck?.tileStyle).toBe('terminal-previews')
  })

  it('drops invalid tileStyle values', () => {
    const normalized = normalizeLocalSettingsPatch({ streamDeck: { tileStyle: 'sparkly' } } as never)
    expect(normalized.streamDeck?.tileStyle).toBeUndefined()
  })

  it('produces no persisted entry at the default value', () => {
    const local = resolveLocalSettings({})
    expect(buildLocalSettingsPatch(local).streamDeck?.tileStyle).toBeUndefined()
  })
})
```

Adapt the exact helper names (`normalizeLocalSettingsPatch`, `resolveLocalSettings`, `buildLocalSettingsPatch`) to what the file already imports — it exercises exactly this normalize→resolve→patch pipeline today; mirror its existing round-trip test's calls verbatim.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `tileStyle` is `undefined` on defaults / dropped by the normalizer.

- [ ] **Step 4: Implement**

In `shared/settings.ts`, next to `TAB_ATTENTION_STYLE_VALUES` (~:262):

```ts
export const DECK_TILE_STYLE_VALUES = ['status-icons', 'terminal-previews'] as const
export type DeckTileStyle = (typeof DECK_TILE_STYLE_VALUES)[number]
const DeckTileStyleSchema = z.enum(DECK_TILE_STYLE_VALUES)
```

Type (~:223): add `tileStyle: DeckTileStyle` to the `streamDeck` object. Defaults (~:895): add `tileStyle: 'status-icons',`. Patch normalizer, inside the `isRecord(patch.streamDeck)` block (~:631-648):

```ts
    if (DeckTileStyleSchema.safeParse(patch.streamDeck.tileStyle).success) {
      streamDeck.tileStyle = patch.streamDeck.tileStyle as DeckTileStyle
    }
```

Add `tileStyle` at every remaining site from Step 1's grep, mirroring `idleTimeoutSeconds` handling exactly (for non-scalar helpers copy the adjacent field's line and change the key). In `src/store/browserPreferencesPersistence.ts` after the `idleTimeoutSeconds` line (~:149):

```ts
  assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'tileStyle')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (whole file, including pre-existing tests).

- [ ] **Step 6: Typecheck, then commit**

Run: `npm run typecheck:client` — expected clean (nothing consumes the field yet; adding it is additive).

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts test/unit/shared/settings.stream-deck.test.ts
git commit -m "feat(deck): streamDeck.tileStyle local setting - status-icons default, terminal-previews opt-in"
```

---

### Task 2: Settings UI — Tile style control (+ SegmentedControl a11y)

**Files:**
- Modify: `src/components/settings/settings-controls.tsx:56-83` (`SegmentedControl`)
- Modify: `src/components/settings/StreamDeckSettings.tsx`
- Test: `test/unit/client/components/settings/StreamDeckSettings.test.tsx`

**Interfaces:**
- Consumes: `DeckTileStyle` from Task 1; `applyLocalSetting: (updates: LocalSettingsPatch) => void` from `SettingsSectionProps`; `SettingsRow`/`SegmentedControl` from `settings-controls.tsx`.
- Produces: a "Tile style" control dispatching `applyLocalSetting({ streamDeck: { tileStyle } })`; `SegmentedControl` accepts optional `'aria-label'`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/components/settings/StreamDeckSettings.test.tsx`, first extend the `renderSection` default fixture (~:23) with the new field:

```tsx
function renderSection(
  streamDeck = { enabled: true, brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300, tileStyle: 'status-icons' as const },
) {
```

Then add:

```tsx
  it('offers the tile style choice with Status icons selected by default', () => {
    renderSection()
    const group = screen.getByRole('group', { name: /tile style/i })
    const statusIcons = within(group).getByRole('button', { name: /status icons/i })
    expect(statusIcons).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: /terminal previews/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('selecting Terminal previews patches streamDeck.tileStyle', () => {
    const { applyLocalSetting } = renderSection()
    fireEvent.click(screen.getByRole('button', { name: /terminal previews/i }))
    expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { tileStyle: 'terminal-previews' } })
  })
```

Add `within` to the existing `@testing-library/react` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — no `group` role, no such buttons.

- [ ] **Step 3: Implement**

`settings-controls.tsx` — upgrade `SegmentedControl` (all existing call sites keep working; the new props are optional/behavior-preserving). Verified: existing call-site tests query `getByRole('button', { name })` only, which this upgrade preserves; the repo's jsx-a11y config has no rule demanding `radiogroup`/`aria-checked`, and `role="group"`+`aria-label` already passes lint elsewhere (`FreshAgentComposer.tsx:569`, `Pane.tsx:82`); `aria-pressed` toggle buttons are the documented WAI-ARIA APG Button pattern. (Note: `TabsView.tsx:297` has a private duplicate `SegmentedControl` that does NOT inherit this upgrade — out of scope, leave it alone.)

```tsx
export function SegmentedControl({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  'aria-label'?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex w-full min-w-0 flex-wrap bg-muted rounded-md p-0.5 md:w-auto md:min-w-[12rem]"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'min-h-10 flex-1 px-3 py-1 text-xs rounded-md transition-colors md:min-h-0 md:flex-none',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
```

`StreamDeckSettings.tsx` — add a row after the "Enable Stream Deck" row (~:75), following the file's existing `streamDeck` accessor:

```tsx
<SettingsRow
  label="Tile style"
  description="Status icons shows repo icons with status backgrounds, sorted by attention. Terminal previews shows live terminal output with status rings, in tab-bar order."
>
  <SegmentedControl
    value={streamDeck.tileStyle}
    aria-label="Tile style"
    options={[
      { value: 'status-icons', label: 'Status icons' },
      { value: 'terminal-previews', label: 'Terminal previews' },
    ]}
    onChange={(v: string) => {
      const tileStyle = v as DeckTileStyle
      applyLocalSetting({ streamDeck: { tileStyle } })
    }}
  />
</SettingsRow>
```

Import `SegmentedControl` from `./settings-controls` and `type { DeckTileStyle }` from `../../../shared/settings` (match the file's existing import path style for `shared/settings`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx test/unit/client/components/settings/ test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS — including all pre-existing settings tests and the other `SegmentedControl` consumers (PanesSettings, VirtualDeckPanel).

- [ ] **Step 5: Lint + typecheck, commit**

Run: `npm run lint && npm run typecheck:client` — expected clean.

```bash
git add src/components/settings/settings-controls.tsx src/components/settings/StreamDeckSettings.tsx test/unit/client/components/settings/StreamDeckSettings.test.tsx
git commit -m "feat(deck): tile style setting UI with a11y-labeled segmented control"
```

---

### Task 3: Restore the terminal-text registry + TerminalView registration

**Files:**
- Restore: `src/deck/terminal-text-registry.ts`
- Restore: `test/unit/client/deck/terminal-text-registry.test.tsx`
- Modify: `src/components/TerminalView.tsx` (2 lines: import + hook call)

**Interfaces:**
- Consumes: nothing new.
- Produces: `registerTerminalTextReader(terminalId, reader)`, `getTerminalTextSnapshot(terminalId)`, `resetTerminalTextRegistryForTests()`, `useTerminalTextRegistration(terminalId, termRef, maxLines = 12)` — consumed by Task 8 (controller `previewFor`) and Task 9 (e2e seeding).

- [ ] **Step 1: Restore the deleted files from git (RED: the restored test file fails to resolve its import until the module is restored — restore both, then run)**

```bash
cd /home/dan/code/freshell/.worktrees/deck-tile-modes
git show ef52f334^:src/deck/terminal-text-registry.ts > src/deck/terminal-text-registry.ts
git show ef52f334^:test/unit/client/deck/terminal-text-registry.test.tsx > test/unit/client/deck/terminal-text-registry.test.tsx
```

The restored module is 53 lines and must match this exactly (verify after restore):

```ts
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'

export type TerminalTextReader = () => string[]
const readers = new Map<string, TerminalTextReader>()

export function registerTerminalTextReader(terminalId: string, reader: TerminalTextReader): () => void {
  readers.set(terminalId, reader)
  return () => {
    if (readers.get(terminalId) === reader) readers.delete(terminalId)
  }
}
export function getTerminalTextSnapshot(terminalId: string): string[] | null {
  const reader = readers.get(terminalId)
  return reader ? reader() : null
}
export function resetTerminalTextRegistryForTests(): void {
  readers.clear()
}

export type XtermLike = {
  buffer: {
    active: {
      length: number
      viewportY: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

export function readXtermTail(term: XtermLike, maxLines: number): string[] {
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - maxLines)
  const out: string[] = []
  for (let y = start; y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return out
}

export function useTerminalTextRegistration(
  terminalId: string | undefined,
  termRef: MutableRefObject<XtermLike | null>,
  maxLines = 12,
): void {
  useEffect(() => {
    if (!terminalId) return
    return registerTerminalTextReader(terminalId, () => {
      const term = termRef.current
      return term ? readXtermTail(term, maxLines) : []
    })
  }, [terminalId, termRef, maxLines])
}
```

- [ ] **Step 2: Run the restored test**

Run: `npm run test:vitest -- run test/unit/client/deck/terminal-text-registry.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (registry round-trip, `readXtermTail` tail semantics, hook register/cleanup/no-op cases).

- [ ] **Step 3: Restore the TerminalView write side**

In `src/components/TerminalView.tsx`, re-add the import (with the file's other `@/deck`-style imports):

```ts
import { useTerminalTextRegistration } from '@/deck/terminal-text-registry'
```

and, immediately after the line `const terminalContent = isTerminal ? paneContent : null` (see `git show ef52f334 -- src/components/TerminalView.tsx` for the exact removal site, ~:673-677 pre-removal):

```ts
  // Register live terminal text reader for Stream Deck previews (classic tile style)
  useTerminalTextRegistration(terminalContent?.terminalId, termRef)
```

- [ ] **Step 4: Verify TerminalView still passes its suite**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView --config config/vitest/vitest.config.ts`
Expected: PASS (if no TerminalView test file matches, run `npm run test:vitest -- run test/unit/client/components/ --config config/vitest/vitest.config.ts` and expect PASS).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck:client` — expected clean.

```bash
git add src/deck/terminal-text-registry.ts test/unit/client/deck/terminal-text-registry.test.tsx src/components/TerminalView.tsx
git commit -m "feat(deck): restore terminal-text registry and TerminalView registration for classic tiles"
```

---

### Task 4: Selector layer — `pendingApproval`, `tileStyle` on the model, gated sort

**Files:**
- Modify: `src/deck/deck-selectors.ts`
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `hasWaitingPrompt` from `@/lib/pane-activity`; `collectPaneEntries` from `@/lib/pane-utils`; `DeckTileStyle` from Task 1; existing `freshAgentSessionFor`, `tilePriority`.
- Produces: `tabHasPendingApproval(state, tabId)` (exported, restored); `DeckTab.pendingApproval: boolean`; `DeckModel.tileStyle: DeckTileStyle`; sort applied only for `'status-icons'`. Tasks 5-9 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/deck-selectors.test.ts`:

(a) Extend the existing test named `'pending permission suppresses busy on the fresh-agent tab'` — this restores the amber-coverage hole the redesign left. Using that test's existing state fixture, add at its end:

```ts
    const model = selectDeckModel(state)
    const freshTab = model.tabs.find((t) => t.id === 't2')!  // adapt the tab id to the fixture's fresh-agent tab
    expect(freshTab.pendingApproval).toBe(true)
    expect(model.tabs.filter((t) => t.pendingApproval)).toHaveLength(1)
```

(b) New tests in the `selectDeckModel` describe (reuse the describe's existing state-builder — the same one its sort/stability tests use). Store/reducer-produced state is **deeply frozen** (RTK/immer auto-freeze — verified: direct mutation throws `Cannot assign to read only property`); do NOT assign onto the built state. Follow the file's own idiom — `withTabAttentionStyle` at `deck-selectors.test.ts:214-218` (`structuredClone`, mutate the clone, reselect) — by adding a sibling helper:

```ts
function withTileStyle(state: RootState, tileStyle: DeckTileStyle): RootState {
  const clone = structuredClone(state) as { settings: { settings: { streamDeck: { tileStyle: string } } } }
  clone.settings.settings.streamDeck.tileStyle = tileStyle
  return clone as unknown as RootState
}
```

(match `withTabAttentionStyle`'s exact typing style rather than this sketch):

```ts
  it('exposes the tile style on the model (default status-icons)', () => {
    const state = /* the describe's existing multi-tab state builder */
    expect(selectDeckModel(state).tileStyle).toBe('status-icons')
  })

  it('terminal-previews style keeps raw tab-bar order (no priority sort)', () => {
    const base = /* the same state the existing sort test uses, where sorting reorders tabs */
    const state = withTileStyle(base, 'terminal-previews')  // clone idiom — direct mutation throws (frozen state)
    const model = selectDeckModel(state)
    expect(model.tileStyle).toBe('terminal-previews')
    expect(model.tabs.map((t) => t.id)).toEqual(state.tabs.tabs.map((t) => t.id))
  })

  it('quiet tabs report pendingApproval false', () => {
    const state = /* the describe's quiet-tabs state */
    expect(selectDeckModel(state).tabs.every((t) => t.pendingApproval === false)).toBe(true)
  })
```

For the `terminal-previews` test, pick/extend the exact fixture the existing `'sorts by status priority'`-style test uses, so tab-bar order and sorted order genuinely differ — the test must fail against sorted output.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `pendingApproval`/`tileStyle` undefined; preview-style order still sorted.

- [ ] **Step 3: Implement**

In `src/deck/deck-selectors.ts`:

Restore the import and function removed by `39b9eff8` (see `git show 39b9eff8^:src/deck/deck-selectors.ts`):

```ts
import { getBusyPaneIdsForTab, hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
```

```ts
export function tabHasPendingApproval(state: RootState, tabId: string): boolean {
  const layout = state.panes.layouts[tabId]
  if (!layout) return false
  return collectPaneEntries(layout).some((entry) =>
    entry.content.kind === 'fresh-agent' && hasWaitingPrompt(freshAgentSessionFor(state, entry.content)))
}
```

Update the types and `selectDeckModel`:

```ts
import type { DeckTileStyle } from '../../shared/settings'  // match the file's existing shared-settings import style

export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null; tileStyle: DeckTileStyle }
// DeckTab gains: pendingApproval: boolean

export function selectDeckModel(state: RootState): DeckModel {
  const activeTabId = state.tabs.activeTabId
  const tileStyle = state.settings.settings.streamDeck.tileStyle
  const tabs = state.tabs.tabs.map((tab) => {
    const active = tab.id === activeTabId
    const flags = getTabStatusFlags(state, tab)
    return {
      id: tab.id,
      title: tab.title,
      active,
      busy: flags.busy,
      attention: flags.attention,
      pendingApproval: tabHasPendingApproval(state, tab.id),
      fill: tileFill(active, flags),
      dot: tileDot(flags),
      priority: tilePriority(active, flags),
      repoIcons: getTabRepoIcons(state, tab),
    }
  })
  if (tileStyle === 'status-icons') {
    // Status-priority sort; Array.prototype.sort is stable, so tab-bar order
    // is preserved within each priority group. Paging slices this sorted list
    // (visibleTabs), so the pager pages over the sorted order automatically.
    // Classic terminal-previews style keeps raw tab-bar order (pre-redesign behavior).
    tabs.sort((a, b) => a.priority - b.priority)
  }
  return { activeTabId, tabs, tileStyle }
}
```

- [ ] **Step 4: Run the deck unit suites**

Run: `npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: PASS. (Existing model-shape assertions use `toMatchObject`, which tolerates the new fields; fix any strict `toEqual` model assertions by adding `pendingApproval: false`/`tileStyle: 'status-icons'` to their expected objects.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck:client` — expected clean.

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts
git commit -m "feat(deck): pendingApproval flag, tileStyle on DeckModel, sort gated to status-icons style"
```

---

### Task 5: Strip "waiting" = attention ∪ pending approval (Change 2)

**Files:**
- Modify: `src/deck/frame.ts` (`stripText`, ~:63-71)
- Test: `test/unit/client/deck/frame.test.ts`

**Interfaces:**
- Consumes: `DeckTab.pendingApproval` from Task 4.
- Produces: `stripText` counting `t.attention || t.pendingApproval`, each tab once. Shared by both styles (no style branch).

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/frame.test.ts`, the existing strip tests build model tabs with flat `busy`/`attention` fields (see the test `'stripText counts busy and waiting from tab flags'`). Add `pendingApproval: false` to the file's tab-fixture helper (`makeDeckTab` or equivalent), then add:

```ts
  it('stripText counts a pending-approval tab as waiting', () => {
    const m = makeModel(3)                      // the file's existing model helper
    m.tabs[1].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('1 waiting')
  })

  it('stripText counts waiting as the union of attention and pending approval', () => {
    const m = makeModel(3)
    m.tabs[0].attention = true
    m.tabs[1].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('2 waiting')
  })

  it('a tab that both needs attention and awaits approval counts once', () => {
    const m = makeModel(2)
    m.tabs[0].attention = true
    m.tabs[0].pendingApproval = true
    expect(stripText(m, 1, 1)).toContain('1 waiting')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — pending-approval-only tab yields `0 waiting`.

- [ ] **Step 3: Implement**

In `src/deck/frame.ts`, update `stripText`'s structural parameter type and the count:

```ts
export function stripText(
  model: { tabs: Array<{ title: string; active: boolean; busy: boolean; attention: boolean; pendingApproval: boolean }> },
  page: number,
  pages: number,
): string {
  const active = model.tabs.find((t) => t.active)
  const busyCount = model.tabs.filter((t) => t.busy).length
  // "waiting" = needs attention (turn complete) OR waiting for approval — each tab once.
  const waitingCount = model.tabs.filter((t) => t.attention || t.pendingApproval).length
  return toAscii(`${active?.title ?? '-'}  |  page ${page}/${pages}  |  ${busyCount} busy  ${waitingCount} waiting`)
}
```

(Keep the exact string template the file has today — only the second count's source changes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/frame.ts test/unit/client/deck/frame.test.ts
git commit -m "feat(deck): strip waiting count unions needs-attention and waiting-for-approval tabs"
```

---

### Task 6: Classic KeySpec variant, `buildFrame` branching, and the classic renderer path

This task lands the frame types and the renderer together because the renderer must exhaustively handle the new `KeySpec` union to typecheck.

**Files:**
- Modify: `src/deck/frame.ts` (`RingColor`, `ringColor`, `KeySpec`, `FrameInputs`, `buildFrame`)
- Modify: `src/deck/tile-renderer.ts` (restore preview constants + helpers + classic draw path; dispatch on `spec.style`)
- Test: `test/unit/client/deck/frame.test.ts`, `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `DeckModel.tileStyle`, `DeckTab.pendingApproval` (Task 4); existing `TileFill`/`TileDot`/`TileIcon`, `drawRing`, `fitLabel`, `truncateTitle`, `BANNER_HEIGHT`, `BANNER_FILL`, `TITLE_FONT_SIZE`, `ACTIVE_COLOR` (all still present at HEAD).
- Produces: the `KeySpec` union, `RingColor`, `ringColor`, `FrameInputs.previewFor`, `RING_COLORS`, `previewGeometry`, `cropPreviewLines` exactly as listed in the Interfaces block at the top of this plan. Task 8 passes `previewFor`; Task 9 asserts decoded specs.

- [ ] **Step 1: Write the failing frame tests**

In `test/unit/client/deck/frame.test.ts`:

(a) Restore the ring-priority describe deleted in `ef52f334`:

```ts
const quiet = { busy: false, green: false, amber: false }

describe('ringColor priority', () => {
  it('amber > green > blue > none', () => {
    expect(ringColor({ busy: true, green: true, amber: true })).toBe('amber')
    expect(ringColor({ busy: true, green: true, amber: false })).toBe('green')
    expect(ringColor({ busy: true, green: false, amber: false })).toBe('blue')
    expect(ringColor(quiet)).toBeNull()
  })
})
```

(b) `buildFrame` style branching (adapt the model/caps fixtures the file's existing `buildFrame` tests use; give the model helper a `tileStyle` field defaulting to `'status-icons'`):

```ts
describe('buildFrame tile styles', () => {
  it('status-icons model yields icons-style tab specs and never calls previewFor', () => {
    const previewFor = vi.fn(() => ['nope'])
    const frame = buildFrame({ model: makeModel(2), caps: MINI, page: 1, actionLayer: null, previewFor })
    expect(frame.keys[0]).toMatchObject({ kind: 'tab', style: 'icons' })
    expect(previewFor).not.toHaveBeenCalled()
  })

  it('terminal-previews model yields preview-style specs with lines and ring', () => {
    const m = makeModel(2)
    m.tileStyle = 'terminal-previews'
    m.tabs[0].busy = true
    m.tabs[1].pendingApproval = true
    const frame = buildFrame({
      model: m, caps: MINI, page: 1, actionLayer: null,
      previewFor: (tabId) => [`preview of ${tabId}`],
    })
    expect(frame.keys[0]).toMatchObject({
      kind: 'tab', style: 'preview', previewLines: ['preview of t1'], ring: 'blue',
    })
    expect(frame.keys[1]).toMatchObject({ kind: 'tab', style: 'preview', ring: 'amber' })
  })
})
```

Also add `previewFor: () => []` to every existing `buildFrame` call in the file (it becomes a required input), and add `style: 'icons'` to any strict spec `toEqual` expectations.

- [ ] **Step 2: Write the failing renderer tests**

In `test/unit/client/deck/tile-renderer.test.ts`:

(a) Restore the two describes deleted in `ef52f334` (these encode real hardware pixel sizes — keep the numbers exact):

```ts
describe('previewGeometry', () => {
  it('matches the hardware-anchored values', () => {
    expect(previewGeometry(120, 120)).toEqual({ lines: 8, columns: 21 })
    expect(previewGeometry(80, 80)).toEqual({ lines: 5, columns: 14 })
    expect(previewGeometry(72, 72)).toEqual({ lines: 4, columns: 12 })
  })
})

describe('cropPreviewLines', () => {
  it('drops trailing blanks, keeps last N lines and first M columns', () => {
    const lines = ['one', 'two-is-longer-than-five', 'three', '', '   ']
    expect(cropPreviewLines(lines, 2, 5)).toEqual(['two-i', 'three'])
  })
})
```

(b) Classic tab rendering, using the file's existing `recordingCtx()` spy and `tabSpec()` helper (add a `previewSpec()` sibling helper):

```ts
function previewSpec(overrides: Partial<Extract<KeySpec, { kind: 'tab'; style: 'preview' }>> = {}) {
  return {
    kind: 'tab' as const, style: 'preview' as const, tabId: 't1', title: 'Tab 1',
    active: false, previewLines: ['$ npm test', 'PASS'], ring: null as RingColor,
    ...overrides,
  }
}

describe('renderKey preview style', () => {
  it('draws preview text in the preview color under the title banner', () => {
    const { ctx, calls } = recordingCtx()
    renderKey(previewSpec(), MINI_CAPS_LIKE, () => ctx)      // adapt to the file's renderKey invocation
    const texts = calls.filter((c) => c.op === 'fillText' && c.style === PREVIEW_TEXT_COLOR)
    expect(texts.map((c) => c.text)).toEqual(['$ npm test', 'PASS'])
  })

  it('status ring + active tab draws the status ring plus the white inner ring', () => {
    const { ctx, calls } = recordingCtx()
    renderKey(previewSpec({ ring: 'green', active: true }), MINI_CAPS_LIKE, () => ctx)
    expect(calls.some((c) => c.op === 'fillRect' && c.style === RING_COLORS.green)).toBe(true)
    expect(calls.some((c) => c.op === 'fillRect' && c.style === ACTIVE_COLOR)).toBe(true) // white inner ring
  })

  it('amber ring renders for a waiting-for-approval tab', () => {
    const { ctx, calls } = recordingCtx()
    renderKey(previewSpec({ ring: 'amber' }), MINI_CAPS_LIKE, () => ctx)
    expect(calls.some((c) => c.op === 'fillRect' && c.style === RING_COLORS.amber)).toBe(true)
  })

  it('icons style still renders fills (dispatch regression)', () => {
    const { ctx, calls } = recordingCtx()
    renderKey(tabSpec({ fill: 'green' }), MINI_CAPS_LIKE, () => ctx)
    expect(calls.some((c) => c.op === 'fillRect' && c.style === '#a7f3d0')).toBe(true) // emerald-200 green fill
  })
})
```

Adapt `recordingCtx` call-shape (`op`/`style`/`text` field names) and the `renderKey` argument list to what the file already uses — copy from its existing `renderKey` tests. Also add `style: 'icons'` to the file's `tabSpec()` helper.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — missing exports (`ringColor`, `previewGeometry`, `cropPreviewLines`, `RING_COLORS`, `PREVIEW_TEXT_COLOR`), unknown `style` field.

- [ ] **Step 4: Implement `frame.ts`**

Restore/introduce (classic pieces verbatim from `git show ef52f334^:src/deck/frame.ts`):

```ts
export type RingColor = 'amber' | 'green' | 'blue' | null

export function ringColor(status: { busy: boolean; green: boolean; amber: boolean }): RingColor {
  if (status.amber) return 'amber'
  if (status.green) return 'green'
  if (status.busy) return 'blue'
  return null
}

export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; style: 'icons'; tabId: string; title: string; active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }
  | { kind: 'tab'; style: 'preview'; tabId: string; title: string; active: boolean; previewLines: string[]; ring: RingColor }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
```

Add to `FrameInputs`:

```ts
  /** Live terminal tail for a tab; only invoked for terminal-previews style. */
  previewFor: (tabId: string) => string[]
```

In `buildFrame`'s tab-key construction (keep the current icons expression byte-identical apart from the added `style` field; `iconReady` stands for the existing readiness expression already in the file):

```ts
    keys[keyIndex] =
      model.tileStyle === 'terminal-previews'
        ? {
            kind: 'tab', style: 'preview', tabId: tab.id, title: tab.title, active: tab.active,
            previewLines: previewFor(tab.id),
            ring: ringColor({ busy: tab.busy, green: tab.attention, amber: tab.pendingApproval }),
          }
        : {
            kind: 'tab', style: 'icons', tabId: tab.id, title: tab.title, active: tab.active,
            fill: tab.fill, dot: tab.dot,
            icons: tab.repoIcons.map((icon) => ({ ...icon, ready: /* existing readiness expression */ })),
          }
```

- [ ] **Step 5: Implement `tile-renderer.ts`**

Restore verbatim from `git show 62fa0ff1:src/deck/tile-renderer.ts` (constants + helpers):

```ts
export const PREVIEW_BG = '#0a0a0a'
export const PREVIEW_TEXT_COLOR = '#a8a8a8'
export const PREVIEW_FONT_SIZE = 11
export const PREVIEW_LINE_HEIGHT = 13
export const PREVIEW_CHAR_WIDTH = 5.5
export const PREVIEW_LEFT_MARGIN = 3
export const RING_COLORS: Record<Exclude<RingColor, null>, string> = {
  amber: '#f59e0b',
  green: '#22c55e',
  blue: '#3b82f6',
}

export function previewGeometry(width: number, height: number): { lines: number; columns: number } {
  return {
    lines: Math.max(1, Math.floor((height - BANNER_HEIGHT - 2) / PREVIEW_LINE_HEIGHT) + 1),
    columns: Math.max(1, Math.floor((width - PREVIEW_LEFT_MARGIN) / PREVIEW_CHAR_WIDTH)),
  }
}

export function cropPreviewLines(lines: string[], maxLines: number, maxColumns: number): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.slice(-maxLines).map((l) => l.slice(0, maxColumns))
}
```

Rename the current private `drawTab` to `drawIconsTab` (body unchanged, parameter type narrowed to the `style: 'icons'` variant), restore the classic path as `drawPreviewTab` (verbatim old `drawTab` from `62fa0ff1`, parameter narrowed to the `style: 'preview'` variant):

```ts
function drawPreviewTab(ctx: Ctx2D, w: number, h: number, spec: Extract<KeySpec, { kind: 'tab'; style: 'preview' }>): void {
  ctx.fillStyle = PREVIEW_BG
  ctx.fillRect(0, 0, w, h)

  const { lines, columns } = previewGeometry(w, h)
  const body = cropPreviewLines(spec.previewLines, lines, columns)
  ctx.font = `${PREVIEW_FONT_SIZE}px monospace`
  ctx.textBaseline = 'top'
  ctx.fillStyle = PREVIEW_TEXT_COLOR
  const baseY = h - body.length * PREVIEW_LINE_HEIGHT - 2
  body.forEach((line, i) => {
    if (line.trim() === '') return
    ctx.fillText(line, PREVIEW_LEFT_MARGIN, baseY + i * PREVIEW_LINE_HEIGHT)
  })

  ctx.fillStyle = BANNER_FILL
  ctx.fillRect(0, 0, w, BANNER_HEIGHT)

  ctx.font = `${TITLE_FONT_SIZE}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 4)
  drawCenteredText(ctx, label, w, 2)

  const ring = spec.ring ? RING_COLORS[spec.ring] : null
  if (ring && spec.active) {
    drawRing(ctx, w, h, ring, 3, 0)
    drawRing(ctx, w, h, ACTIVE_COLOR, 2, 3)
  } else if (ring) {
    drawRing(ctx, w, h, ring, 4, 0)
  } else if (spec.active) {
    drawRing(ctx, w, h, ACTIVE_COLOR, 3, 0)
  }
}

function drawTab(ctx: Ctx2D, w: number, h: number, spec: Extract<KeySpec, { kind: 'tab' }>, getIcon: IconSource): void {
  if (spec.style === 'preview') return drawPreviewTab(ctx, w, h, spec)
  drawIconsTab(ctx, w, h, spec, getIcon)
}
```

Adapt `drawTab`/`drawIconsTab` parameter lists (`getIcon` etc.) to the file's current signatures; import `RingColor` as a type from `./frame`. `Ctx2D` needs no widening — the classic path only uses `fillRect`/`fillText`/`measureText`, so `VirtualDeckPanel`'s `noopCtx` is untouched.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Fix the remaining compile error, typecheck, commit**

`deck-controller.ts` now fails typecheck (`buildFrame` requires `previewFor`). Add the minimal stub `previewFor: () => []` to its `buildFrame` call — Task 8 immediately replaces it with the real reader (this stub is a compile bridge inside this plan, not a deferred behavior; Task 8's tests prove the production path).

Run: `npm run typecheck:client && npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: clean + PASS.

```bash
git add src/deck/frame.ts src/deck/tile-renderer.ts src/deck/deck-controller.ts test/unit/client/deck/frame.test.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): dual tile-style KeySpec with restored classic preview+ring render path"
```

---

### Task 7: Controller — style-gated capture polling and preview reads

**Files:**
- Modify: `src/deck/deck-controller.ts`
- Test: `test/unit/client/deck/deck-controller.test.ts`

**Interfaces:**
- Consumes: `getTerminalTextSnapshot` (Task 3), `findPaneContent` from `@/lib/pane-utils` (pre-removal import — verify the exact source module with `git show fb09f7e3^:src/deck/deck-controller.ts`), `FrameInputs.previewFor` (Task 6), `DeckTileStyle` (Task 1).
- Produces: `PREVIEW_REFRESH_TICKS = 6` (exported); `DeckControllerOptions.settings` return type gains `tileStyle: DeckTileStyle`; polling repaints only in `'terminal-previews'` style.

- [ ] **Step 1: Update settings fixtures (compile-first)**

In `test/unit/client/deck/deck-controller.test.ts`, the suite's settings fixture/thunk (the one its idle-dim tests customize) must gain `tileStyle: 'status-icons' as const`. Same for any other object satisfying the controller's settings type in this file.

- [ ] **Step 2: Write the failing tests**

Rename the existing test `'no periodic repaint: 3s of ticks paints nothing while the store is unchanged'` to scope it to the default style, and add the classic-mode pair. Model all three on the pre-removal test (`git show ef52f334^:test/unit/client/deck/deck-controller.test.ts` shows the original changing-reader idiom); use the file's `setup()` helper, passing `tileStyle` through its settings parameter the same way the idle tests pass `idleTimeoutSeconds`:

```ts
import { registerTerminalTextReader } from '@/deck/terminal-text-registry'

  it('status-icons style: 3s of ticks paints nothing even when terminal text changes', () => {
    // A CHANGING reader is what makes this RED if polling leaks into the new style.
    let n = 0
    const unregister = registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { device } = setup({ tabCount: 1 })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0)
    unregister()
  })

  it('terminal-previews style: changing terminal text repaints within PREVIEW_REFRESH_TICKS', () => {
    let n = 0
    const unregister = registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { device } = setup({ tabCount: 1 }, /* settings override: */ { tileStyle: 'terminal-previews' })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBeGreaterThan(0)
    unregister()
  })

  it('terminal-previews style: static terminal text does not repaint on ticks', () => {
    const unregister = registerTerminalTextReader('term-1', () => ['same line'])
    const { device } = setup({ tabCount: 1 }, { tileStyle: 'terminal-previews' })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0)  // spec JSON unchanged -> per-key diff skips
    unregister()
  })
```

Adapt the `setup()` override plumbing to the helper's actual signature. Add `resetTerminalTextRegistryForTests()` to the suite's `afterEach` (the pre-removal suite did the same).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — classic-mode test paints nothing (no polling exists yet).

- [ ] **Step 4: Implement**

In `src/deck/deck-controller.ts` (hand-merge; reference `git show fb09f7e3^:src/deck/deck-controller.ts` — do NOT reverse-apply the commit, it bundles IconImageCache work that must stay):

```ts
import { findPaneContent } from '@/lib/pane-utils'
import { getTerminalTextSnapshot } from './terminal-text-registry'

// Deliberate exception to the file's TIMING RULE: this is a refresh cadence, not a
// duration — under background setInterval throttling previews simply refresh slower.
export const PREVIEW_REFRESH_TICKS = 6 // previews re-checked every 3s
```

Options type:

```ts
  settings: () => { brightness: number; idleBrightness: number; idleTimeoutSeconds: number; tileStyle: DeckTileStyle }
```

Private members + methods:

```ts
  private tickCount = 0

  private previewFor(state: RootState, tabId: string): string[] {
    const paneId = state.panes.activePane[tabId]
    const layout = state.panes.layouts[tabId]
    if (!paneId || !layout) return []
    const content = findPaneContent(layout, paneId)
    if (content && content.kind === 'terminal' && content.terminalId) {
      return getTerminalTextSnapshot(content.terminalId) ?? []
    }
    return []
  }

  private tick(): void {
    this.dutyChecks()
    if (this.settings().tileStyle !== 'terminal-previews') return
    this.tickCount++
    if (this.tickCount % PREVIEW_REFRESH_TICKS === 0) this.repaint() // picks up xterm buffer changes
  }
```

In `repaint()`, replace Task 6's `previewFor: () => []` stub with the real reader (using the method's local `state` variable):

```ts
      previewFor: (tabId) => this.previewFor(state, tabId),
```

Preserve the current `onStoreChange()` ordering: `probeRepoIcons()` stays BEFORE the model-JSON bail-out; preview reads happen only inside `repaint()` (i.e., after the bail-out) — restore the pre-removal ORDERING comment there:

```ts
    // ORDERING (load-bearing): compare the model JSON BEFORE any xterm buffer
    // reads - previewFor is only invoked by repaint, which we skip entirely
    // when the model is unchanged.
```

Production call sites (`deck-manager.ts:95-101`, `VirtualDeckPanel.tsx:82-88`) already pass the whole `streamDeck` settings object as the thunk — no changes needed there.

- [ ] **Step 5: Run the controller suite + e2e compile check**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: controller suite PASS. The e2e file needs two small fixture edits here before its scenarios pass (test files are outside the tsconfig `include` and Vitest strips types, so neither omission fails compilation — the signal is runtime/assertion behavior, not a compile error):

1. Add `tileStyle: 'status-icons' as const` to its `defaultSettings()` fixture. (Without it, `tileStyle` is `undefined` at runtime, which behaves as status-icons — make the edit anyway so the fixture matches the settings type.)
2. In the `'tabs appear on keys with titles, fills, dots, and icons'` scenario (~lines 198-209), add `style: 'icons'` to each of the three strict `toEqual` tab-spec expectations. Task 6's tab `KeySpec` now carries a `style` field, and strict `toEqual` fails on the extra property — without this edit those three assertions FAIL.

After both edits, all existing e2e scenarios must PASS unchanged (the Deck+ strip test still reads `1 waiting` because its `attention: { t2: true }` seed satisfies the union).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck:client` — expected clean.

```bash
git add src/deck/deck-controller.ts test/unit/client/deck/deck-controller.test.ts test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): restore preview capture polling, gated to the terminal-previews tile style"
```

---

### Task 8: E2E — classic journey, live style switching, no-polling proof, strip union

**Files:**
- Test: `test/e2e/stream-deck-flow.test.tsx`

**Interfaces:**
- Consumes: everything above through the REAL store + REAL `DeckController` + `FakeDeckDevice`; `registerTerminalTextReader`/`resetTerminalTextRegistryForTests` (Task 3); the settings reducer's local-patch action.
- Produces: end-to-end proof of every user-facing requirement.

- [ ] **Step 1: Note the settings patch action (verified)**

The production action is `updateSettingsLocal(payload: LocalSettingsPatch)` (`src/store/settingsSlice.ts:117-122`, exported ~:136) — NOT `mergeLocalSettings`, which is a pure helper imported from `@shared/settings`. Verified: its reducer recomputes the resolved `state.settings.settings` inline in the same dispatch, so asserting synchronously after `store.dispatch(updateSettingsLocal(...))` is valid — no settle step needed. One trap (verified): the payload is filtered through `extractLegacyLocalSettingsSeed` (`settingsSlice.ts:45-50`), so if Task 1 missed any of its whitelist sites the dispatch silently no-ops — the first new test below therefore includes a sanity assertion that the patch actually landed in `state.settings.localSettings`.

- [ ] **Step 2: Write the failing tests**

Add to `test/e2e/stream-deck-flow.test.tsx`. Imports: `registerTerminalTextReader`, `resetTerminalTextRegistryForTests` from `@/deck/terminal-text-registry`; `updateSettingsLocal` from `@/store/settingsSlice`. Add `resetTerminalTextRegistryForTests()` to the existing `afterEach`. Add a live-settings setup variant next to `setup()`:

```tsx
// Like setup(), but the controller reads settings live from the real store,
// so dispatching a settings patch changes controller behavior mid-session.
function setupLive(opts: DeckStoreOpts = {}, caps?: DeckCapabilities) {
  const store = makeDeckStore(opts)
  const device = new FakeDeckDevice(caps)
  const controller = new DeckController({
    store: store as never,
    device,
    renderKey: (spec) => encodeSpec(spec),
    renderStrip: (text) => new TextEncoder().encode(text) as unknown as Uint8ClampedArray,
    settings: () => store.getState().settings.settings.streamDeck,
  })
  controller.start()
  activeController = controller
  return { store, device, controller }
}
```

New describe:

```tsx
describe('tile styles', () => {
  it('classic style: tabs appear with titles, previews, and rings, in tab-bar order', () => {
    registerTerminalTextReader('term-1', () => ['$ npm test', 'PASS'])
    const { device } = setupLive({ tabs: 3, activeTab: 't1', busy: ['term-2'], attention: { t3: true } })
    // start in default style, flip to classic through the production settings path
    // (or preload localSettings if makeDeckStore supports it — either is fine)
    // ...dispatch happens in the switch test below; here seed classic directly:
    activeController!.stop()
    const { device: d2 } = setupLive({ tabs: 3, activeTab: 't1', busy: ['term-2'], attention: { t3: true }, tileStyle: 'terminal-previews' })
    expect(decodeKey(d2, 0)).toMatchObject({
      kind: 'tab', style: 'preview', tabId: 't1',
      previewLines: ['$ npm test', 'PASS'], active: true,
    })
    // tab-bar order, NOT attention-sorted: t3 (attention) stays on key 2
    expect(decodeKey(d2, 1)).toMatchObject({ tabId: 't2', ring: 'blue' })
    expect(decodeKey(d2, 2)).toMatchObject({ tabId: 't3', ring: 'green' })
  })

  it('switching styles live repaints, reorders, and stops/starts polling — no reload', () => {
    let n = 0
    registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { store, device } = setupLive({ tabs: 3, activeTab: 't1', attention: { t3: true } })
    // default: icons style, attention-sorted (t3 first)
    expect(decodeKey(device, 0)).toMatchObject({ style: 'icons', tabId: 't3', fill: 'green' })

    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    // sanity: the patch survived the shared-settings whitelists (guards a silent no-op; see Step 1)
    expect(store.getState().settings.settings.streamDeck.tileStyle).toBe('terminal-previews')
    // live re-sort to tab-bar order + preview specs
    expect(decodeKey(device, 0)).toMatchObject({ style: 'preview', tabId: 't1' })
    expect(decodeKey(device, 2)).toMatchObject({ style: 'preview', tabId: 't3', ring: 'green' })
    // polling is live: changing text repaints within 3s
    const before = decodeKey(device, 0)!
    vi.advanceTimersByTime(3_000)
    expect(decodeKey(device, 0)).not.toEqual(before)

    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'status-icons' } }))
    // back to sorted icons style...
    expect(decodeKey(device, 0)).toMatchObject({ style: 'icons', tabId: 't3' })
    // ...and polling stops: 3s of changing text paints nothing
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0)
  })

  it('mid-press style switch does not retarget the press', () => {
    const { store, device } = setupLive({ tabs: 3, activeTab: 't1', attention: { t3: true } })
    // key 0 is t3 (sorted). Press down, flip style (re-sorts to tab-bar order), release.
    device.emit({ type: 'keyDown', keyIndex: 0 })
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    device.emit({ type: 'keyUp', keyIndex: 0 })
    expect(store.getState().tabs.activeTabId).toBe('t3')  // press-snapshot guard holds across the flip
  })

  it('Deck+ strip counts waiting as attention OR pending approval, in both styles', () => {
    const { store, device } = setupLive({ tabs: 2, freshAgentTab: 2, attention: { t1: true } }, PLUS_CAPS)
    store.dispatch(addPermissionRequest({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    }))
    expect(decodeStrip(device)).toContain('2 waiting')
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    expect(decodeStrip(device)).toContain('2 waiting')
  })
})
```

Fixture adaptations required (make them, don't skip): (a) if `makeDeckStore` has no `tileStyle` opt, add one that preloads `settings.localSettings.streamDeck.tileStyle` (or dispatch `updateSettingsLocal` right after store creation — either way the first test must start classic BEFORE the controller's first paint, or assert post-dispatch state instead); (b) the `addPermissionRequest` import and `freshAgentTab` wiring already exist — copy from the existing test `'tile fill and dot track state changes'`; (c) `attention`/`busy` opt shapes come from the existing scenarios.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: the new describe FAILS only where fixtures are missing (e.g. no `tileStyle` opt) — everything behavioral should pass because Tasks 1-7 built the machinery. Fix fixture plumbing until the suite is green; if a BEHAVIORAL assertion fails, the corresponding earlier task has a bug — fix it there (with its unit test) rather than bending the e2e.

- [ ] **Step 4: Run the whole deck surface**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/stream-deck-flow.test.tsx
git commit -m "test(deck): e2e coverage for tile-style switching, classic previews, polling gate, strip waiting union"
```

---

### Task 9: README + full verification sweep

**Files:**
- Modify: `README.md` (line 35 feature bullet; Stream Deck section lines 68-93)

**Interfaces:**
- Consumes: final behavior from all prior tasks.
- Produces: accurate end-user docs; a green combined branch.

- [ ] **Step 1: Update README**

Replace the stale feature bullet at line 35 with:

```markdown
- **Stream Deck** — Drive freshell from an Elgato Stream Deck: tabs on keys with repo icons and status backgrounds (or classic live previews and status rings), press to focus, long-press to approve or stop agents. See [Stream Deck](#stream-deck).
```

Replace the section intro paragraph (line 70) with:

```markdown
Freshell can drive an Elgato Stream Deck straight from the browser. Each key shows a tab — by default the **Status icons** style: title on top, centered repo icons, and a status background (green for tabs that want attention), with keys sorted so attention-seeking tabs come first. Press a key to focus that tab; long-press (500 ms) to open an action layer with BACK / APPROVE / STOP keys (it closes itself after 10 s). When you have more tabs than keys, the last key pages through them (wrapping around). On a Stream Deck +, the dials cycle tabs and flip pages and the touch strip shows the active tab plus busy/waiting counts (waiting = tabs that finished a turn or are waiting for approval). The deck dims after a configurable idle timeout and wakes on activity.
```

Insert after the Virtual deck paragraph (after line 79):

```markdown
**Tile style:** Settings → Stream Deck → **Tile style** switches between **Status icons** (the default, described above) and **Terminal previews** — the classic look with a title banner, a live mini terminal preview on each key, and colored status rings (blue busy, green needs-attention, amber waiting for approval), with keys in plain tab-bar order. Switching takes effect immediately, on the hardware deck and the virtual deck alike.
```

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npm run typecheck:client`
Expected: clean.

- [ ] **Step 3: Focused deck surface, then the coordinated suite**

```bash
npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx test/unit/client/components/ test/unit/shared/settings.stream-deck.test.ts --config config/vitest/vitest.config.ts
npm run test:status    # check the coordinator gate; WAIT if another agent holds it — never kill a foreign holder
FRESHELL_TEST_SUMMARY="deck tile-style setting + strip waiting union" npm test
```

Expected: all green. If `npm test` surfaces failures outside the deck surface, fix only regressions this branch introduced.

- [ ] **Step 4: Manual smoke note (no server restart!)**

Optional visual check via the virtual deck (Settings → Stream Deck → Show virtual deck) in a dev client: toggle Tile style and watch tiles flip between icon tiles and preview tiles live. Do NOT restart anything on port 3002.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the Stream Deck tile-style setting and strip waiting semantics"
```

---

## Verification Against Success Criteria

- **Default behaves exactly like `feat/deck-tile-redesign` + waiting union:** default `'status-icons'` leaves the model/spec pipeline identical except additive fields; Task 7 proves zero polling; Task 5/8 prove the strip union. All pre-existing redesign tests keep running unmodified (only additive fixture fields).
- **Selecting Terminal previews restores previews + rings + tab-bar order with live polling; switching back stops polling:** Task 8's live-switch e2e + Task 7's unit gates, visible on the virtual deck (shares the controller/renderer).
- **Strip union in both styles:** Task 5 units (incl. count-once) + Task 8 e2e in both styles.
- **All tests green on the combined branch:** Task 9 coordinated sweep.
