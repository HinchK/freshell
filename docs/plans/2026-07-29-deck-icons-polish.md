# Stream Deck "Status icons" Tile Visual Polish Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the default "Status icons" Stream Deck tile style look like freshell itself: circle letter avatars identical to the tab bar's RepoIcon, all deck text in Inter, a palette derived from the app's own color tokens, and the bottom status dot replaced by tab-bar-style tinted coding-agent icons drawn next to the repo icon.

**Architecture:** All changes are client-only and live in `src/deck/` plus small shared-constant extractions from the tab bar components. The rendering pipeline is: Redux store → `deck-selectors.ts` (`DeckModel`) → `frame.ts` (`KeySpec`) → `tile-renderer.ts` (canvas draw via injectable `Ctx2D`) → `deck-controller.ts` (diff + paint) → WebHID device or `VirtualDeckPanel.tsx` emulator. We widen the narrow `Ctx2D` type for circles, add a font-loading module with a controller repaint hook, re-derive color constants with a documented token mapping, and plumb per-tab agent-pane icon data (`paneIcons`) through selectors → frame → renderer, deleting the `dot` from the icons `KeySpec`. Agent icons exist only as React SVG components, so a new `provider-icon-svg.ts` serializes them with `renderToStaticMarkup`, injects the tint color, and feeds them through the existing `IconImageCache` (keeping its blank-draw detection).

**Tech Stack:** TypeScript, React 18.3, Redux Toolkit, Canvas 2D, Vite 5, `@fontsource/inter` (new dep), Vitest + jsdom (recorded-draw-call testing — no real canvas in tests).

## Global Constraints

- Icons style only: `drawPreviewTab` (`src/deck/tile-renderer.ts:108-141`), `PREVIEW_*` constants, and `RING_COLORS` are PINNED — byte-for-byte unchanged. (Design decision: the spec requires both "previews unchanged" and "banner/pager/action/strip text in Inter"; pager/action/strip keys are style-independent so they get Inter, and the title banner gets Inter **in the icons path only** — the preview tile's banner keeps `sans-serif`.)
- `src/deck/tile-state.ts` (states, priority, sorting) is UNCHANGED. `DeckTab.dot` keeps existing; only the icons-style `KeySpec` loses `dot`.
- Sorting, interaction, settings, and all server code unchanged. No server/Rust changes.
- Red-Green-Refactor TDD for every task (repo rule). Focused runs: `npm run test:vitest -- run <path> --config config/vitest/vitest.config.ts`. Raw `npx vitest` is forbidden.
- Never restart the live Rust server on port 3002 (requires the literal word "APPROVED"). `scripts/launch-rust.sh --client-only` + browser hard refresh is allowed. No broad kill patterns (`pkill -f vite`, `pkill node`, etc.).
- Do NOT create or open a PR without explicit user approval.
- Work happens in this worktree (`.worktrees/deck-icons-polish`), branch based on `origin/main` (HEAD `7e29dad1`).
- No runtime font fetch from external CDNs — Inter must be an npm-bundled local asset.
- All deck error paths are SILENT — `console.error` is fatal in tests; a failed icon/font load is expected, not exceptional.
- jsdom has no canvas (`getContext` stubbed to `null` in `test/setup/dom.ts:31-42`) and no `document.fonts` — all new browser-API use must be feature-guarded and tests must inject fakes.
- `README.md` stays the only end-user markdown doc; this plan under `docs/plans/` is a working doc.
- Keep commits focused and atomic; commit at the end of every task.

## Environment note for every task

Run all commands from the worktree root: `/home/dan/code/freshell/.worktrees/deck-icons-polish`. (The vitest config excludes `.worktrees/**`, so running from the main checkout silently skips these files.)

---

### Task 1: Export shared letter-avatar constants from RepoIcon

The deck must derive avatar color and letter proportions from the SAME code the tab bar uses. Today `RepoIcon.tsx` exports `hueFromString` (already imported by `deck-selectors.ts:10`), but the `hsl(${hue}, 60%, 42%)` fill string and the 9/16 letter-size ratio are inline literals duplicated in `tile-renderer.ts`.

**Files:**
- Modify: `src/components/icons/RepoIcon.tsx`
- Test: `test/unit/client/components/icons/RepoIcon.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2):
  - `export function repoAvatarColor(hue: number): string` — returns `` `hsl(${hue}, 60%, 42%)` ``
  - `export const REPO_AVATAR_FONT_RATIO: number` — `9 / 16` (letter font-size as a fraction of the avatar diameter)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/client/components/icons/RepoIcon.test.tsx` (inside the top-level `describe`; add `repoAvatarColor, REPO_AVATAR_FONT_RATIO` to the existing import from `@/components/icons/RepoIcon`):

```tsx
describe('shared avatar constants', () => {
  it('repoAvatarColor formats the canonical 60%/42% HSL fill', () => {
    expect(repoAvatarColor(200)).toBe('hsl(200, 60%, 42%)')
    expect(repoAvatarColor(0)).toBe('hsl(0, 60%, 42%)')
  })

  it('the letter-avatar circle fill and font size use the shared constants', () => {
    render(<RepoIcon info={{ repoKey: '/r/alpha', repoName: 'alpha' }} />)
    const circle = document.querySelector('circle')
    expect(circle?.getAttribute('fill')).toBe(repoAvatarColor(hueFromString('alpha')))
    const text = document.querySelector('text')
    // viewBox is 16 units; fontSize must be 16 * ratio = 9
    expect(text?.getAttribute('font-size')).toBe(String(16 * REPO_AVATAR_FONT_RATIO))
  })
})
```

(If the file does not already import `render` from `@testing-library/react` or `hueFromString`, add those imports — check the top of the file first; it already tests the letter avatar so most imports exist.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/icons/RepoIcon.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `repoAvatarColor` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/components/icons/RepoIcon.tsx`, add below `hueFromString`:

```tsx
/**
 * Canonical letter-avatar fill. 60% saturation / 42% lightness keeps white
 * text readable in both themes. Shared with the deck's canvas replica
 * (src/deck/tile-renderer.ts) — change it here and both surfaces follow.
 */
export function repoAvatarColor(hue: number): string {
  return `hsl(${hue}, 60%, 42%)`
}

/** Letter font-size as a fraction of the avatar diameter (SVG: 9 units / 16-unit viewBox). */
export const REPO_AVATAR_FONT_RATIO = 9 / 16
```

Then update the component body to use them (replacing the inline literals):

```tsx
  const letter = (info.repoName.trim()[0] || '?').toUpperCase()
  const hue = hueFromString(info.repoName)
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="8" cy="8" r="8" fill={repoAvatarColor(hue)} />
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={16 * REPO_AVATAR_FONT_RATIO}
        fontWeight="600"
        fill="white"
      >
        {letter}
      </text>
    </svg>
  )
```

(Delete the now-redundant `// 60% saturation / 42% lightness…` comment from the component body — it moved to the helper.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/icons/RepoIcon.test.tsx test/e2e/repo-icon-tab-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (both the new tests and the existing avatar tests — rendering output is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/components/icons/RepoIcon.tsx test/unit/client/components/icons/RepoIcon.test.tsx
git commit -m "refactor(icons): export shared repoAvatarColor + letter font ratio from RepoIcon"
```

---

### Task 2: Circle letter avatar on deck tiles (widen Ctx2D)

Replace the deck's square letter avatar with an exact canvas replica of RepoIcon's circle: same color function, same 9/16 letter ratio, same +0.5/16 optical nudge, white 600-weight letter. `Ctx2D` (`tile-renderer.ts:8-11`) has no `arc`, so it must be widened — in lockstep with the two fake contexts (`recordingCtx` in the renderer test, `noopCtx` in `VirtualDeckPanel.tsx:22-33`).

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Modify: `src/components/VirtualDeckPanel.tsx`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `repoAvatarColor(hue)`, `REPO_AVATAR_FONT_RATIO` from `@/components/icons/RepoIcon` (Task 1).
- Produces: `Ctx2D` now includes `'beginPath' | 'arc' | 'fill'` (later tasks and both ctx fakes rely on this exact widening). The recording harness gains a `circles: Array<{ cx: number; cy: number; r: number; style: string }>` channel.

- [ ] **Step 1: Extend the recording harness (test infrastructure, no assertions yet)**

In `test/unit/client/deck/tile-renderer.test.ts`, extend `recordingCtx` (currently lines 15-36) to record circles, and thread `circles` through the `renderTab` helper's return:

```ts
type Circle = { cx: number; cy: number; r: number; style: string }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
  const images: Img[] = []
  const circles: Circle[] = []
  let pendingArc: { cx: number; cy: number; r: number } | null = null
  const ctx = {
    fillStyle: '#000000' as string,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) })
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, style: String(this.fillStyle), font: this.font })
    },
    drawImage(_src: CanvasImageSource, x: number, y: number, w: number, h: number) {
      images.push({ x, y, w, h })
    },
    beginPath() {
      pendingArc = null
    },
    arc(cx: number, cy: number, r: number) {
      pendingArc = { cx, cy, r }
    },
    fill() {
      if (pendingArc) circles.push({ ...pendingArc, style: String(this.fillStyle) })
      pendingArc = null
    },
    measureText(t: string) { return { width: t.length * 6 } as TextMetrics },
    getImageData() { return { data: new Uint8ClampedArray(width * height * 4) } as ImageData },
  } as unknown as Ctx2D
  return { ctx, rects, texts, images, circles }
}
```

Update `renderTab` to also return `circles`:

```ts
  const { rects, texts, images, circles } = captured!
  return { out, rects, texts, images, circles }
```

- [ ] **Step 2: Write the failing tests**

Replace the existing letter-avatar test (`'unready or letter-only icon draws the hue swatch + white letter fallback'`, ~lines 141-148) with (add `repoAvatarColor, REPO_AVATAR_FONT_RATIO` to the imports from `@/components/icons/RepoIcon`, and keep the `iconLayout` import):

```ts
it('unready or letter-only icon draws RepoIcon\'s circle avatar + centered white letter', () => {
  const { rects, texts, images, circles } = renderTab(
    tabSpec({ icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
  )
  expect(images).toHaveLength(0)
  const slot = iconLayout(80, 80, 1)[0]
  // Exact replica of RepoIcon's SVG: full-slot circle, shared color function.
  expect(circles).toEqual([
    { cx: slot.x + slot.size / 2, cy: slot.y + slot.size / 2, r: slot.size / 2, style: repoAvatarColor(200) },
  ])
  // The old square swatch is gone.
  expect(rects.some((r) => r.style === repoAvatarColor(200))).toBe(false)
  const letter = texts.find((t) => t.text === 'B')
  expect(letter?.style).toBe('#ffffff')
  // 9/16 of the diameter, weight 600 (slot.size is 30 on the 80x80 Mini -> 17px).
  expect(letter?.font).toBe(`600 ${Math.round(slot.size * REPO_AVATAR_FONT_RATIO)}px sans-serif`)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `circles` is empty (renderer still draws a square), and TypeScript may complain about `beginPath`/`arc`/`fill` missing from `Ctx2D` in the harness cast (the `as unknown as Ctx2D` cast suppresses this; the runtime assertion failure is the RED signal).

- [ ] **Step 4: Widen Ctx2D and draw the circle avatar**

In `src/deck/tile-renderer.ts`, change the `Ctx2D` type (lines 8-11) to:

```ts
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'getImageData' | 'drawImage' | 'beginPath' | 'arc' | 'fill'
> & { fillStyle: string | CanvasGradient | CanvasPattern; font: string; textBaseline: CanvasTextBaseline }
```

Add the import at the top:

```ts
import { repoAvatarColor, REPO_AVATAR_FONT_RATIO } from '@/components/icons/RepoIcon'
```

In `drawIconsTab`, replace the letter-avatar block (currently the `// Letter avatar (canvas analogue of RepoIcon's SVG circle): hue swatch + white letter.` comment plus the six lines after it) with:

```ts
    // Letter avatar: exact canvas replica of RepoIcon's SVG — circle filling
    // the slot, letter at 9/16 of the diameter, weight 600, white, with
    // RepoIcon's +0.5/16 optical nudge below true center (y=8.5 in a 16-unit box).
    const cx = x + size / 2
    const cy = y + size / 2
    ctx.fillStyle = repoAvatarColor(icon.hue)
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = `600 ${Math.round(size * REPO_AVATAR_FONT_RATIO)}px sans-serif`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    const letterWidth = ctx.measureText(icon.letter).width
    ctx.fillText(icon.letter, Math.round(cx - letterWidth / 2), Math.round(cy + size * (0.5 / 16)))
```

In `src/components/VirtualDeckPanel.tsx`, extend `noopCtx` (lines ~22-33) with the three new no-ops:

```tsx
    fillRect: () => {}, fillText: () => {}, drawImage: () => {},
    beginPath: () => {}, arc: () => {}, fill: () => {},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS. Then `npm run typecheck` — expected clean (both fake contexts satisfy the widened type).

- [ ] **Step 6: Commit**

```bash
git add src/deck/tile-renderer.ts src/components/VirtualDeckPanel.tsx test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): letter avatar is a circle matching RepoIcon exactly (shared color + ratio)"
```

---

### Task 3: Bundle Inter locally and add the deck font module

Inter is NOT in the repo today (no `@font-face`, no font files, no fontsource package — the UI uses a system stack at `src/index.css:1370`). Bundle it via `@fontsource/inter` (npm asset, Vite hashes the woff2 files — no CDN fetch) and add `src/deck/deck-font.ts`: the font-family constants plus a guarded "call me when loaded" helper. Canvas `ctx.font` never triggers webfont loading, so the controller (Task 5) must await the load and repaint; until then `Inter, sans-serif` silently falls back.

**Files:**
- Modify: `package.json` / `package-lock.json` (new dependency `@fontsource/inter`)
- Modify: `src/index.css` (two `@import` lines at the very top)
- Create: `src/deck/deck-font.ts`
- Test: `test/unit/client/deck/deck-font.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Tasks 4 and 5):
  - `export const DECK_FONT_FAMILY = 'Inter'`
  - `export const DECK_FONT_STACK = 'Inter, sans-serif'`
  - `export function whenDeckFontReady(onReady: () => void): () => void` — invokes `onReady` once after weights 400 and 600 load; returns a cancel function; silent no-op (never calls `onReady`, never throws) when `document.fonts` is unavailable (jsdom) or the load fails.

- [ ] **Step 1: Install the font**

```bash
npm install @fontsource/inter
```

Expected: `@fontsource/inter` appears in `package.json` dependencies.

- [ ] **Step 2: Register the faces**

At the VERY TOP of `src/index.css` (CSS `@import` must precede all other rules), add:

```css
/* Inter (local npm asset, weights used by the Stream Deck tiles — see src/deck/deck-font.ts). */
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/600.css';
```

Do NOT change the app's `font-family` rule — the UI keeps its system stack; Inter is registered for the deck canvas (and available to anything else later).

- [ ] **Step 3: Write the failing tests**

Create `test/unit/client/deck/deck-font.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECK_FONT_FAMILY, DECK_FONT_STACK, whenDeckFontReady } from '@/deck/deck-font'

// jsdom has no document.fonts; tests that need one install a mock and restore it.
afterEach(() => {
  delete (document as unknown as { fonts?: unknown }).fonts
})

function installFontsMock() {
  const load = vi.fn().mockResolvedValue([])
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
  return { load }
}

describe('deck-font', () => {
  it('exposes the Inter family with a sans-serif fallback', () => {
    expect(DECK_FONT_FAMILY).toBe('Inter')
    expect(DECK_FONT_STACK).toBe('Inter, sans-serif')
  })

  it('is a silent no-op without document.fonts (jsdom): never calls onReady, never throws', async () => {
    const onReady = vi.fn()
    const cancel = whenDeckFontReady(onReady)
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()
    expect(cancel).not.toThrow()
  })

  it('loads weights 400 and 600 then calls onReady once', async () => {
    const { load } = installFontsMock()
    const onReady = vi.fn()
    whenDeckFontReady(onReady)
    expect(load).toHaveBeenCalledWith('400 16px "Inter"')
    expect(load).toHaveBeenCalledWith('600 16px "Inter"')
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  it('cancel prevents a late load from calling onReady', async () => {
    installFontsMock()
    const onReady = vi.fn()
    const cancel = whenDeckFontReady(onReady)
    cancel()
    await new Promise((r) => setTimeout(r, 0))
    expect(onReady).not.toHaveBeenCalled()
  })

  it('a failed load stays silent (fallback font keeps working)', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no font'))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
    const onReady = vi.fn()
    whenDeckFontReady(onReady) // must not throw / unhandled-reject / console.error
    await new Promise((r) => setTimeout(r, 0))
    expect(onReady).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-font.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module `@/deck/deck-font` does not exist.

- [ ] **Step 5: Write the implementation**

Create `src/deck/deck-font.ts`:

```ts
// Deck tile typeface: Inter, bundled locally via @fontsource (src/index.css
// imports weights 400/600 — no CDN fetch). Canvas ctx.font does NOT trigger
// webfont loading, so the deck controller waits for the FontFace load and
// forces a repaint; until then every deck font string falls back to
// sans-serif (DECK_FONT_STACK lists it second) without breaking.
// jsdom has no document.fonts: every path here degrades to a silent no-op
// (console.error is fatal in tests; a missing font is expected, not
// exceptional — same rule as icon-image-cache.ts).

export const DECK_FONT_FAMILY = 'Inter'
/** Family list for ctx.font strings: Inter once loaded, sans-serif before. */
export const DECK_FONT_STACK = `${DECK_FONT_FAMILY}, sans-serif`

/**
 * Invoke onReady once the deck's font weights (400 + 600) are loaded so the
 * caller can repaint with Inter. Returns a cancel function — after cancel a
 * late load is ignored (the controller calls it from stop()).
 */
export function whenDeckFontReady(onReady: () => void): () => void {
  let cancelled = false
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load) return () => { cancelled = true }
  void Promise.all([
    fonts.load(`400 16px "${DECK_FONT_FAMILY}"`),
    fonts.load(`600 16px "${DECK_FONT_FAMILY}"`),
  ])
    .then(() => {
      if (!cancelled) onReady()
    })
    .catch(() => {
      // Font failure -> keep the sans-serif fallback, silently.
    })
  return () => { cancelled = true }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-font.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/index.css src/deck/deck-font.ts test/unit/client/deck/deck-font.test.ts
git commit -m "feat(deck): bundle Inter locally and add guarded deck font loader"
```

---

### Task 4: Render all deck text in Inter

Switch every deck text surface except the pinned preview path to `DECK_FONT_STACK`, with weight 600 for the icons-tile title banner, avatar letters, page number, and action labels, and weight 400 for the dim pager labels and the strip. Name the previously magic pager/action font sizes.

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `DECK_FONT_STACK` from `@/deck/deck-font` (Task 3).
- Produces (referenced by later test updates): `export const CONTROL_LABEL_FONT_SIZE = 11`, `export const CONTROL_VALUE_FONT_SIZE = 15`. Font strings become (exactly):
  - icons banner: `` `600 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}` ``
  - avatar letter: `` `600 ${Math.round(size * REPO_AVATAR_FONT_RATIO)}px ${DECK_FONT_STACK}` ``
  - pager PAGE/NEXT: `` `400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}` ``; pager page count and action labels: `` `600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``
  - strip: `` `400 ${STRIP_FONT_SIZE}px ${DECK_FONT_STACK}` ``
  - preview tile: UNCHANGED (`${PREVIEW_FONT_SIZE}px monospace` body, `${TITLE_FONT_SIZE}px sans-serif` banner).

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/tile-renderer.test.ts`, add a new `describe('fonts (Inter)')` block. Import `DECK_FONT_STACK` from `@/deck/deck-font` and add `CONTROL_LABEL_FONT_SIZE, CONTROL_VALUE_FONT_SIZE, TITLE_FONT_SIZE, STRIP_FONT_SIZE` to the imports from `@/deck/tile-renderer`. The harness already captures `ctx.font` per `fillText` into `Text.font` — no harness change needed. For the strip, mirror the existing render-entry pattern: call `renderStrip('hello', 800, 100, factory)` with a capturing factory identical to `renderTab`'s.

```ts
describe('fonts (Inter)', () => {
  it('icons tile: banner title and avatar letter render in 600-weight Inter', () => {
    const { texts } = renderTab(
      tabSpec({ title: 'build', icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
    )
    const title = texts.find((t) => t.text === 'build')
    expect(title?.font).toBe(`600 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`)
    const letter = texts.find((t) => t.text === 'B')
    expect(letter?.font).toContain(`px ${DECK_FONT_STACK}`)
    expect(letter?.font.startsWith('600 ')).toBe(true)
  })

  it('pager: dim labels are 400 Inter, the page count is 600 Inter', () => {
    const { texts } = renderTab({ kind: 'pager', page: 2, pageCount: 3 })
    expect(texts.find((t) => t.text === 'PAGE')?.font).toBe(`400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}`)
    expect(texts.find((t) => t.text === 'NEXT >')?.font).toBe(`400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}`)
    expect(texts.find((t) => t.text === '2/3')?.font).toBe(`600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('action key labels render in 600 Inter', () => {
    const { texts } = renderTab({ kind: 'action', action: 'approve', enabled: true })
    expect(texts.find((t) => t.text === 'APPROVE')?.font).toBe(`600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('strip text renders in 400 Inter', () => {
    let captured: ReturnType<typeof recordingCtx> | null = null
    const factory = (w: number, h: number) => {
      captured = recordingCtx(w, h)
      return captured.ctx
    }
    renderStrip('hello', 800, 100, factory)
    expect(captured!.texts.find((t) => t.text === 'hello')?.font).toBe(`400 ${STRIP_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('classic preview tile is PINNED: monospace body, sans-serif banner', () => {
    const { texts } = renderTab(previewSpec({ title: 'build', previewLines: ['$ ls'] }))
    expect(texts.find((t) => t.text === '$ ls')?.font).toBe('11px monospace')
    expect(texts.find((t) => t.text === 'build')?.font).toBe(`${TITLE_FONT_SIZE}px sans-serif`)
  })
})
```

(Note: `renderTab` accepts any `KeySpec` — it just calls `renderKey`; check its local signature and widen the parameter type from the tab-spec builder type to `KeySpec` if needed. `renderStrip` must be added to the imports from `@/deck/tile-renderer` if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — fonts are still `sans-serif` without weights, `CONTROL_LABEL_FONT_SIZE` is not exported.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts`:

1. Add import: `import { DECK_FONT_STACK } from './deck-font'`
2. Add constants next to `STRIP_FONT_SIZE`:

```ts
export const CONTROL_LABEL_FONT_SIZE = 11
export const CONTROL_VALUE_FONT_SIZE = 15
```

3. Apply the exact font strings from the Interfaces block above:
   - `drawIconsTab` banner: `ctx.font = \`600 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}\``
   - `drawIconsTab` avatar letter (Task 2's line): `ctx.font = \`600 ${Math.round(size * REPO_AVATAR_FONT_RATIO)}px ${DECK_FONT_STACK}\``
   - `drawPager`: `'11px sans-serif'` → `` `400 ${CONTROL_LABEL_FONT_SIZE}px ${DECK_FONT_STACK}` `` (both occurrences); `'15px sans-serif'` → `` `600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``; replace the bare `15` in `(h - 15) / 2` with `CONTROL_VALUE_FONT_SIZE` and the bare `11` in `h - 11 - 4` with `CONTROL_LABEL_FONT_SIZE`.
   - `drawAction`: `'15px sans-serif'` → `` `600 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``; replace its bare `15` with `CONTROL_VALUE_FONT_SIZE`.
   - `renderStrip`: `` `${STRIP_FONT_SIZE}px sans-serif` `` → `` `400 ${STRIP_FONT_SIZE}px ${DECK_FONT_STACK}` ``
   - `drawPreviewTab`: DO NOT TOUCH.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (the `measureText` stub is family-agnostic, so centering assertions are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): render all deck text in Inter (previews pinned to sans-serif)"
```

---

### Task 5: Repaint the deck when Inter finishes loading

`DeckController.repaint()` diffs on `JSON.stringify(spec)` (`deck-controller.ts:148`); a font load changes no KeySpec, so a naive repaint would diff-out to zero paints. The controller must invalidate `lastPaintedSpecs`/`lastStripText` first. Wire `whenDeckFontReady` as an injectable option so tests drive it deterministically.

**Files:**
- Modify: `src/deck/deck-controller.ts`
- Test: `test/e2e/stream-deck-flow.test.tsx`

**Interfaces:**
- Consumes: `whenDeckFontReady` from `@/deck/deck-font` (Task 3).
- Produces: `DeckControllerOptions` gains `fontReady?: (onReady: () => void) => () => void` (defaults to `whenDeckFontReady`). Both the hardware path and `VirtualDeckPanel` construct `DeckController`, so both get the behavior with no other changes.

- [ ] **Step 1: Write the failing test**

In `test/e2e/stream-deck-flow.test.tsx`, add inside the top-level describe (the `setup()` helper already accepts a 4th `extra?: Partial<DeckControllerOptions>` param, spread into the controller options):

```tsx
describe('deck font loading', () => {
  it('font ready forces a full repaint of otherwise-unchanged keys, and stop() cancels the wait', () => {
    let fontCb: (() => void) | null = null
    let cancelled = false
    const { device, controller } = setup({ tabs: 2 }, undefined, defaultSettings, {
      fontReady: (onReady) => {
        fontCb = onReady
        return () => { cancelled = true }
      },
    })
    expect(fontCb).not.toBeNull()
    // Steady state: nothing changed, so a plain repaint would paint zero keys.
    device.keyImages.clear()
    fontCb!()
    // The font hook invalidates the diff cache -> every visible key repaints.
    expect(device.keyImages.size).toBeGreaterThan(0)
    controller.stop()
    expect(cancelled).toBe(true)
  })
})
```

(Adapt the `setup({ tabs: 2 }, ...)` store options to whatever `DeckStoreOpts` shape the file's `makeDeckStore` uses — mirror the options used by the neighboring tests, e.g. the `tile styles` block; only the 4th argument matters here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `fontReady` is not a known `DeckControllerOptions` key (TS error) or `fontCb` stays null.

- [ ] **Step 3: Implement**

In `src/deck/deck-controller.ts`:

1. Import: `import { whenDeckFontReady } from './deck-font'`
2. Add to `DeckControllerOptions` (after `iconCache?`):

```ts
  /** Injectable font-ready hook (defaults to whenDeckFontReady); tests drive it directly. */
  fontReady?: (onReady: () => void) => () => void
```

3. Add fields/ctor wiring (next to the other `unsubscribe*` fields at lines 73-77 and in the constructor):

```ts
  private readonly fontReady: (onReady: () => void) => () => void
  private cancelFontWait: (() => void) | null = null
```

```ts
    this.fontReady = options.fontReady ?? whenDeckFontReady
```

4. In `start()`, directly after the `unsubscribeIcons` line (line 95):

```ts
    this.cancelFontWait = this.fontReady(() => {
      // A font load changes no KeySpec, so the JSON diff (repaint(), line ~148)
      // would paint nothing: invalidate the caches to force a real repaint in Inter.
      this.lastPaintedSpecs = []
      this.lastStripText = null
      this.repaint()
    })
```

5. In `stop()`, in the same style as the other pairs (lines 107-112):

```ts
    this.cancelFontWait?.()
    this.cancelFontWait = null
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx test/unit/client/deck/deck-controller.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (existing controller tests unaffected: in jsdom the default `whenDeckFontReady` is a silent no-op).

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-controller.ts test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): force full repaint once Inter loads (injectable fontReady hook)"
```

---

### Task 6: Cohesive palette derived from freshell's tokens

Re-derive the icons-style/control-key constants from the app's own tokens (`src/theme-variables.css`, TabItem's tailwind classes) and document the mapping in a comment block. Value changes: `TILE_BG` `#0a0a0a`→`#09090b` (`--background` dark), `TILE_FILL_GREEN` `#a7f3d0`→`#d1fae5` (`bg-emerald-100`, the tab bar's actual green-fill token, light variant for LCD legibility), `CONTROL_BG` `#101036`→`#27272a` (`bg-muted` dark), `CONTROL_DIM` `#8888aa`→`#a1a1aa` (`text-muted-foreground` dark), `APPROVE_COLOR` `#22c55e`→`#21c45d` (`--success`, fixing 1-off drift), `STOP_COLOR` `#ef4444`→`#dc2828` (`--destructive` light variant `hsl(0 72% 51%)`, vivid enough for the LCD). Renames: `DOT_GREEN`→`STATUS_GREEN`, `DOT_BLUE`→`STATUS_BLUE` (values already exact token matches — they become the pane-icon tints in Task 10). `BAR_TOP_BORDER` (`#21c45d` = `--success` exactly) and `ACTIVE_COLOR`/`BANNER_FILL`/`EMPTY_BG` keep their values but join the mapping doc. `PREVIEW_*` and `RING_COLORS` are pinned (classic style).

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 9-10 and tests): `STATUS_GREEN` (`'#21c45d'`), `STATUS_BLUE` (`'#3b82f6'`) replace `DOT_GREEN`/`DOT_BLUE`. `DOT_SIZE` remains (removed in Task 9). All other names unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/tile-renderer.test.ts`:

1. Change the imports from `@/deck/tile-renderer`: `DOT_GREEN`→`STATUS_GREEN`, `DOT_BLUE`→`STATUS_BLUE`; add `CONTROL_BG`, `CONTROL_DIM`, `STOP_COLOR`, `PREVIEW_TEXT_COLOR` if missing; update the two usages in the status-dot test accordingly.
2. De-hardcode the literal color assertions (they bypass constants today): line ~110 `'#a8a8a8'`→`PREVIEW_TEXT_COLOR`, line ~175 `'#101036'`→`CONTROL_BG`, line ~210 `'#a7f3d0'`→`TILE_FILL_GREEN`.
3. Add the mapping lock test:

```ts
describe('palette derives from the app UI tokens (mapping block in tile-renderer.ts)', () => {
  it('matches the documented app-token values', () => {
    expect(TILE_BG).toBe('#09090b')          // --background dark: hsl(240 10% 4%)
    expect(TILE_FILL_GREEN).toBe('#d1fae5')  // bg-emerald-100 (TabItem green-filled tab)
    expect(BAR_TOP_BORDER).toBe('#21c45d')   // --success: hsl(142 71% 45%)
    expect(STATUS_GREEN).toBe('#21c45d')     // text-success (pane running tint)
    expect(STATUS_BLUE).toBe('#3b82f6')      // text-blue-500 (pane busy tint)
    expect(ACTIVE_COLOR).toBe('#ffffff')     // white active ring
    expect(CONTROL_BG).toBe('#27272a')       // bg-muted dark
    expect(CONTROL_DIM).toBe('#a1a1aa')      // text-muted-foreground dark
    expect(APPROVE_COLOR).toBe('#21c45d')    // --success
    expect(STOP_COLOR).toBe('#dc2828')       // --destructive light: hsl(0 72% 51%)
  })

  it('classic previews palette is PINNED', () => {
    expect(PREVIEW_BG).toBe('#0a0a0a')
    expect(PREVIEW_TEXT_COLOR).toBe('#a8a8a8')
    expect(RING_COLORS).toEqual({ amber: '#f59e0b', green: '#22c55e', blue: '#3b82f6' })
  })
})
```

(Add `PREVIEW_BG` to imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — old values / `STATUS_GREEN` not exported.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts`, replace the constants block (lines 18-50) documentation and values. Keep `PREVIEW_*`, `RING_COLORS`, `BANNER_*`, `TITLE_FONT_SIZE`, `ACTIVE_COLOR`, `DOT_SIZE`, `ICON_GAP`, `DISABLED_ACTION_COLOR`, `EMPTY_BG`, `STRIP_FONT_SIZE`, `MAX_TITLE_CHARS` where noted; apply this exact mapping block and the changed values:

```ts
// ============================================================================
// DECK PALETTE — derived from freshell's own UI palette so the deck reads as
// part of the app. KEEP IN SYNC: when an app token changes, update the deck
// constant to match. Lightness/opacity may be tuned for the small dark LCD;
// hues must stay the app's (see docs/plans/2026-07-29-deck-icons-polish.md).
//
//   deck constant     <- app source token (where it lives)                 value
//   TILE_BG           <- --background dark  (src/theme-variables.css)      hsl(240 10% 4%)  = #09090b
//   TILE_FILL_GREEN   <- bg-emerald-100     (TabItem.tsx green-filled tab) #d1fae5
//                        light-theme variant: the dark-theme emerald-900/40
//                        fill is illegible at key size on the LCD.
//   BAR_TOP_BORDER    <- border-t-success / --success (TabItem bar-on-top) hsl(142 71% 45%) = #21c45d
//   STATUS_GREEN      <- text-success       (TabItem pane running tint)    hsl(142 71% 45%) = #21c45d
//   STATUS_BLUE       <- text-blue-500      (TabItem pane busy tint)       #3b82f6
//   ACTIVE_COLOR      <- white active ring (deck-only affordance)          #ffffff
//   BANNER_FILL       <- black scrim over the tile (shared w/ previews)    rgba(0,0,0,0.667)
//   CONTROL_BG        <- bg-muted dark      (src/theme-variables.css)      hsl(240 4% 16%)  = #27272a
//   CONTROL_DIM       <- text-muted-foreground dark                        hsl(240 5% 65%)  = #a1a1aa
//   APPROVE_COLOR     <- --success                                         #21c45d
//   STOP_COLOR        <- --destructive light: hsl(0 72% 51%)               #dc2828
//                        (light variant: the dark-theme destructive is too
//                        dull for an action ring on the LCD)
//   PREVIEW_* / RING_COLORS: classic terminal-previews style — PINNED,
//   deliberately not re-derived (that style must not change).
// ============================================================================
```

Changed lines:

```ts
export const TILE_BG = '#09090b'
export const TILE_FILL_GREEN = '#d1fae5'
export const STATUS_GREEN = '#21c45d'
export const STATUS_BLUE = '#3b82f6'
export const CONTROL_BG = '#27272a'
export const CONTROL_DIM = '#a1a1aa'
export const APPROVE_COLOR = '#21c45d'
export const STOP_COLOR = '#dc2828'
```

Update the two usages of `DOT_GREEN`/`DOT_BLUE` in `drawIconsTab` to `STATUS_GREEN`/`STATUS_BLUE`. Grep to confirm no other references remain:

```bash
grep -rn "DOT_GREEN\|DOT_BLUE" src/ test/
```

Expected: zero hits after the rename.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): re-derive tile palette from the app's UI tokens with documented mapping"
```

---

### Task 7: Serialize tab-bar agent icons for canvas (`provider-icon-svg.ts`)

The coding-agent icons exist ONLY as React SVG components drawing with `currentColor` (`src/components/icons/provider-icons.tsx` — Claude/Codex/Kimi/Opencode/Gemini/Amplifier + `DefaultProviderIcon`; fresh-agent types map via `resolveFreshAgentType` in `src/lib/fresh-agent-registry.ts`, e.g. `freshclaude`→`FreshclaudeIcon`, `kilroy`→stroke-based `KilroyIcon`). Serialize them with `renderToStaticMarkup`, inject the tint via a `color` attribute on the root `<svg>` (drives `currentColor` for both fills AND strokes inside an `<img>`-loaded SVG), ensure `xmlns` (required for standalone SVG), and expose a data URL for the existing `IconImageCache` (which keeps its blank-draw probe and silent failure handling).

**Files:**
- Create: `src/deck/provider-icon-svg.ts`
- Test: `test/unit/client/deck/provider-icon-svg.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_ICONS`, `DefaultProviderIcon` from `@/components/icons/provider-icons`; `resolveFreshAgentType` from `@/lib/fresh-agent-registry`; `react-dom/server` (first use in the repo — react-dom 18.3.1 is already installed, no dependency change).
- Produces (used by Task 10):
  - `export function providerIconSvg(provider: string, colorHex: string): string` — standalone tinted SVG markup; provider is a terminal `mode` (e.g. `'claude'`) or fresh-agent `sessionType` (e.g. `'freshclaude'`); unknown → `DefaultProviderIcon`. Memoized per `(provider, colorHex)`.
  - `export function providerIconDataUrl(provider: string, colorHex: string): string` — `data:image/svg+xml;utf8,<encoded markup>` (stable string: safe as an `IconImageCache`/diff key).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/deck/provider-icon-svg.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { providerIconDataUrl, providerIconSvg } from '@/deck/provider-icon-svg'
import { ClaudeIcon, DefaultProviderIcon, KilroyIcon } from '@/components/icons/provider-icons'

describe('providerIconSvg', () => {
  it('serializes a terminal-mode provider to standalone SVG with the tint color on the root', () => {
    const svg = providerIconSvg('claude', '#3b82f6')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('color="#3b82f6"')
    // Same geometry as the tab bar's component (currentColor paths preserved).
    const raw = renderToStaticMarkup(createElement(ClaudeIcon))
    expect(svg).toContain(raw.slice(raw.indexOf('<path')))
  })

  it('resolves fresh-agent sessionTypes via the registry (freshclaude) and strokes via color (kilroy)', () => {
    expect(providerIconSvg('freshclaude', '#21c45d')).toContain('color="#21c45d"')
    const kilroy = providerIconSvg('kilroy', '#21c45d')
    expect(kilroy).toContain('color="#21c45d"')
    expect(kilroy).toContain(renderToStaticMarkup(createElement(KilroyIcon)).slice(0, 4)) // sanity: it serialized
  })

  it('unknown providers fall back to DefaultProviderIcon', () => {
    const svg = providerIconSvg('mystery-cli', '#a1a1aa')
    const raw = renderToStaticMarkup(createElement(DefaultProviderIcon))
    expect(svg).toContain(raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')))
  })

  it('memoizes markup and produces a stable, encoded data URL', () => {
    expect(providerIconSvg('claude', '#3b82f6')).toBe(providerIconSvg('claude', '#3b82f6'))
    const url = providerIconDataUrl('claude', '#3b82f6')
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(url).toBe(providerIconDataUrl('claude', '#3b82f6'))
    expect(url).not.toContain('<') // encoded
  })

  it('does not duplicate xmlns when the component already declares it', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'gemini', 'freshclaude']) {
      const svg = providerIconSvg(provider, '#ffffff')
      expect(svg.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)?.length).toBe(1)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/provider-icon-svg.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/deck/provider-icon-svg.ts`:

```ts
// Canvas-side bridge to the tab bar's coding-agent icons. The icons exist
// ONLY as React SVG components drawing with currentColor
// (provider-icons.tsx + fresh-agent-registry.ts), so we serialize them with
// renderToStaticMarkup and inject the tint via a color attribute on the root
// <svg> — inside an <img>-loaded SVG, currentColor resolves through the
// inherited `color` property, which tints solid fills AND strokes (KilroyIcon
// is stroke-based). The data URL feeds the existing IconImageCache: same
// async load, same drawn-empty probe, same silent failure -> no-icon path.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultProviderIcon, PROVIDER_ICONS } from '@/components/icons/provider-icons'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

const markupCache = new Map<string, string>()

/**
 * Standalone tinted SVG markup for a provider. `provider` is a terminal
 * mode ('claude', 'codex', ...) or a fresh-agent sessionType ('freshclaude',
 * ...); anything unknown gets DefaultProviderIcon (same rule as PaneIcon).
 */
export function providerIconSvg(provider: string, colorHex: string): string {
  const key = `${provider}\u0000${colorHex}`
  const hit = markupCache.get(key)
  if (hit) return hit
  const Icon = resolveFreshAgentType(provider)?.icon ?? PROVIDER_ICONS[provider] ?? DefaultProviderIcon
  const raw = renderToStaticMarkup(createElement(Icon))
  let svg = raw.replace('<svg', `<svg color="${colorHex}"`)
  // Standalone SVG (loaded via <img src="data:...">) requires xmlns; React
  // components may or may not declare it.
  if (!svg.includes('xmlns=')) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  markupCache.set(key, svg)
  return svg
}

/** Stable per-(provider, tint) data URL for IconImageCache and KeySpec diffing. */
export function providerIconDataUrl(provider: string, colorHex: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(providerIconSvg(provider, colorHex))}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/provider-icon-svg.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS. If the geometry-containment assertions fail because a component renders attributes in a different order than a fresh `renderToStaticMarkup` call, loosen those specific assertions to check a distinctive substring (e.g. the component's `viewBox` value) — the load-bearing assertions are `color=`, `xmlns`, fallback, and memoization.

- [ ] **Step 5: Commit**

```bash
git add src/deck/provider-icon-svg.ts test/unit/client/deck/provider-icon-svg.test.ts
git commit -m "feat(deck): serialize tab-bar agent icons to tinted standalone SVG data URLs"
```

---

### Task 8: Derive per-tab agent pane icons in deck-selectors

Plumb agent identity + tint from the store to the deck model. `panesForTab` already yields full `PaneContent`; today everything but repo cwd is discarded. Mirror `TabItem.tsx`'s `renderIcons()` tint rules exactly: busy (from `getBusyPaneIdsForTab`) wins → blue; otherwise the pane's effective status (non-terminal kinds count as `'running'`) maps like `getTerminalStatusIconClassName`.

**Files:**
- Modify: `src/deck/deck-selectors.ts`
- Modify: `test/unit/client/deck/frame.test.ts` (fixture only — `DeckTab` gains a field)
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: existing module-internal helpers `panesForTab`, `getBusyPaneIdsForTab`, `activityInputs` (all already used by `getTabStatusFlags` in this file); `isNonShellMode` from `@/lib/coding-cli-utils` (new import).
- Produces (used by Tasks 9-10):
  - `export type TilePaneTint = 'blue' | 'green' | 'amber' | 'red' | 'mutedDim' | 'muted'`
  - `export type TilePaneIcon = { provider: string; tint: TilePaneTint }`
  - `export function getTabPaneIcons(state: RootState, tab: Tab): TilePaneIcon[]` — agent panes only, layout order, UNCAPPED (renderer caps + badges).
  - `DeckTab` gains `paneIcons: TilePaneIcon[]`; `selectDeckModel` populates it.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/deck-selectors.test.ts`, add `getTabPaneIcons` to the imports from `@/deck/deck-selectors` and append (the default `makeState()` fixture gives tab t1 a `mode: 'claude'` terminal pane p1/term-1 with overridable `paneStatus`, and tab t2 a `freshclaude` fresh-agent pane; `claudeBusy: true` marks term-1 busy; `split`/`claudeLeaf` helpers exist near line 277):

```ts
describe('getTabPaneIcons', () => {
  it('non-shell terminal pane -> provider = mode, tint green when running and not busy', () => {
    const state = makeState()
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint: 'green' }])
  })

  it('busy wins over status: busy claude pane tints blue', () => {
    const state = makeState({ claudeBusy: true })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint: 'blue' }])
  })

  it('fresh-agent pane -> provider = sessionType, treated as running (green) unless busy', () => {
    const state = makeState()
    expect(getTabPaneIcons(state, tabsOf(state)[1])).toEqual([{ provider: 'freshclaude', tint: 'green' }])
  })

  it('shell panes yield no agent icon', () => {
    const state = makeState({
      t1Layout: { type: 'leaf', id: 'p1', content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell' } } as never,
    })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([])
  })

  it('status maps like the tab bar: exited -> mutedDim, error -> red, creating -> muted, recovering -> amber', () => {
    for (const [status, tint] of [['exited', 'mutedDim'], ['error', 'red'], ['creating', 'muted'], ['recovering', 'amber']] as const) {
      const state = makeState({ paneStatus: { p1: status } })
      expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint }])
    }
  })

  it('multiple agent panes stay in layout order and are NOT capped here', () => {
    const state = makeState({
      t1Layout: split('s1', claudeLeaf('p1', 'term-1'), split('s2', claudeLeaf('p2', 'term-2'), claudeLeaf('p3', 'term-3'))),
      busy: ['term-2'],
    })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([
      { provider: 'claude', tint: 'green' },
      { provider: 'claude', tint: 'blue' },
      { provider: 'claude', tint: 'green' },
    ])
  })

  it('selectDeckModel carries paneIcons per tab', () => {
    const state = makeState({ claudeBusy: true })
    const model = selectDeckModel(state)
    const t1 = model.tabs.find((t) => t.id === 't1')!
    expect(t1.paneIcons).toEqual([{ provider: 'claude', tint: 'blue' }])
  })
})
```

(If `'recovering'` is not a valid `paneStatus` value in the fixture's typing, drop that single tuple — the switch default still gets covered by `'creating'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `getTabPaneIcons` is not exported.

- [ ] **Step 3: Implement**

In `src/deck/deck-selectors.ts`:

1. Add import: `import { isNonShellMode } from '@/lib/coding-cli-utils'`
2. Add to the `DeckTab` type (after `repoIcons`): `paneIcons: TilePaneIcon[]`
3. Add below `getTabRepoIcons`:

```ts
/** Tint states for agent pane icons — TabItem.tsx's icon classes, projected to the canvas. */
export type TilePaneTint = 'blue' | 'green' | 'amber' | 'red' | 'mutedDim' | 'muted'
export type TilePaneIcon = { provider: string; tint: TilePaneTint }

/** Mirrors getTerminalStatusIconClassName (src/lib/terminal-status-indicator.ts). */
function paneStatusTint(status: string): TilePaneTint {
  switch (status) {
    case 'running': return 'green'      // text-success
    case 'recovering': return 'amber'   // text-warning
    case 'exited': return 'mutedDim'    // text-muted-foreground/40
    case 'error': return 'red'          // text-destructive
    default: return 'muted'             // creating etc. -> text-muted-foreground
  }
}

/**
 * Agent pane icons for a tab, in layout order, UNCAPPED (the renderer caps
 * drawn icons and folds the rest into a +N badge — TabItem's MAX_PANE_ICONS
 * overflow rule adapted to key size). Agent panes are non-shell terminals
 * (provider = mode) and fresh-agent panes (provider = sessionType);
 * shell/browser/editor/picker/extension panes draw no agent icon on a key
 * this small. Tint mirrors TabItem.tsx renderIcons: busy -> blue (wins),
 * else the pane's effective status (non-terminal kinds count as 'running').
 */
export function getTabPaneIcons(state: RootState, tab: Tab): TilePaneIcon[] {
  const busyIds = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  })
  const icons: TilePaneIcon[] = []
  for (const { paneId, content } of panesForTab(state, tab)) {
    let provider: string | null = null
    let status = 'running'
    if (content.kind === 'terminal' && isNonShellMode(content.mode)) {
      provider = content.mode
      status = content.status
    } else if (content.kind === 'fresh-agent') {
      provider = content.sessionType
    }
    if (!provider) continue
    icons.push({ provider, tint: busyIds.includes(paneId) ? 'blue' : paneStatusTint(status) })
  }
  return icons
}
```

(Match this file's existing `getBusyPaneIdsForTab({ tab, paneLayouts, ...activityInputs(state) })` call in `getTabStatusFlags` exactly — reuse the same helper names/casts it uses.)

4. In `selectDeckModel`, add to the per-tab object literal (after `repoIcons: getTabRepoIcons(state, tab),`):

```ts
      paneIcons: getTabPaneIcons(state, tab),
```

5. `DeckTab` changed, so fix compile errors in fixtures: in `test/unit/client/deck/frame.test.ts`, `makeDeckTab` (line 10) gains `paneIcons: []` in its defaults:

```ts
    active: false, busy: false, attention: false, pendingApproval: false, fill: 'none', dot: null,
    priority: 4, repoIcons: [], paneIcons: [], ...over,
```

Run `npm run typecheck` and add `paneIcons: []` to any other `DeckTab` literal it flags (possible in `deck-controller.test.ts` / `deck-manager.test.ts` if they build models by hand).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts test/unit/client/deck/frame.test.ts
git commit -m "feat(deck): derive per-tab agent pane icons with tab-bar tint rules"
```

---

### Task 9: KeySpec carries paneIcons; the status dot is deleted

Replace `dot` with `paneIcons` in the icons-style `KeySpec` and delete the dot rendering. After this task the dot is gone everywhere on the wire and the canvas (the renderer draws the pane icons in Task 10). `DeckTab.dot` and `tile-state.ts` stay untouched (sorting/priority unchanged).

**Files:**
- Modify: `src/deck/frame.ts`
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/frame.test.ts`, `test/unit/client/deck/tile-renderer.test.ts`, `test/e2e/stream-deck-flow.test.tsx`

**Interfaces:**
- Consumes: `TilePaneIcon` from `./deck-selectors` (Task 8).
- Produces: icons-style `KeySpec` member becomes
  `{ kind: 'tab'; style: 'icons'; tabId: string; title: string; active: boolean; fill: TileFill; paneIcons: TilePaneIcon[]; icons: TileIcon[] }`
  (`dot` removed; `DOT_SIZE` deleted from the renderer). Task 10 renders `paneIcons`.

- [ ] **Step 1: Write the failing tests (frame level)**

In `test/unit/client/deck/frame.test.ts`:

1. `makeDeckTab` defaults (updated in Task 8) need NO change here: `DeckTab` still has `dot` (tile-state is untouched), so keep `dot: null` in the fixture defaults. Only the `KeySpec` loses `dot`.
2. Update the primary carry test (lines ~84-108, `'buildFrame carries fill/dot/icons onto tab keys...'`): rename it to `'buildFrame carries fill/paneIcons/icons onto tab keys, with iconReady resolving readiness'`; in the fixture tab replace nothing (keep `dot: 'green'` on the DeckTab — it is simply no longer carried) but add `paneIcons: [{ provider: 'claude', tint: 'green' }]`; in the asserted KeySpec replace `dot: 'green',` with `paneIcons: [{ provider: 'claude', tint: 'green' }],`. Import `TilePaneIcon` if the file annotates types.

- [ ] **Step 2: Write the failing tests (renderer level)**

In `test/unit/client/deck/tile-renderer.test.ts`:

1. In the `tabSpec()` builder (~line 80), replace `dot: null` with `paneIcons: []`.
2. Delete the status-dot test (`'status dot: green and blue variants at bottom-center; absent when null'`, ~lines 150-157) and remove `DOT_SIZE` (and now-unused `STATUS_*` if unreferenced until Task 10) from the imports.
3. Add the regression test:

```ts
it('no status dot: a plain icons tile draws only the background and the banner', () => {
  const { rects } = renderTab(tabSpec())
  // background + banner — nothing else (the dot used to be a third rect)
  expect(rects).toHaveLength(2)
})
```

- [ ] **Step 3: Update the e2e KeySpec assertions**

In `test/e2e/stream-deck-flow.test.tsx` (the renderer is stubbed to encode KeySpec JSON, so these assert the wire format): apply the mechanical rule — a `dot: 'green'` expectation becomes `paneIcons: [{ provider: P, tint: 'green' }]`, `dot: 'blue'` becomes `paneIcons: [{ provider: P, tint: 'blue' }]`, `dot: null`/absent becomes `paneIcons: []`, where `P` is the fixture pane's mode/sessionType for that tab (read the `makeDeckStore` fixture at the top of the file; its terminal panes use a coding mode, typically `'claude'`).

Known assertion sites (from a repo-wide `.dot` sweep): lines ~230, ~234, ~238 (exact `toEqual` — must list `paneIcons` and no `dot`), ~256, ~259, ~267, ~410, ~411 (`toMatchObject` — replace the `dot` key with the `paneIcons` array). After editing, run the suite and reconcile any remaining diffs against the fixture (the diff output shows the actual `paneIcons` values produced by the real selectors — verify they match the rule above rather than blindly copying).

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts test/unit/client/deck/tile-renderer.test.ts test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `paneIcons` is not a `KeySpec` field (TS), the renderer still draws the dot rect.

- [ ] **Step 5: Implement**

In `src/deck/frame.ts`:

1. Line 3: drop `TileDot` from the `tile-state` import (keep `TileFill`).
2. Line 2 area: extend the deck-selectors import: `import type { DeckModel, TilePaneIcon } from './deck-selectors'`
3. Line 10, the icons member becomes:

```ts
  | { kind: 'tab'; style: 'icons'; tabId: string; title: string; active: boolean; fill: TileFill; paneIcons: TilePaneIcon[]; icons: TileIcon[] }
```

4. In `buildFrame` (line 122), replace `fill: tab.fill, dot: tab.dot,` with:

```ts
            fill: tab.fill, paneIcons: tab.paneIcons,
```

In `src/deck/tile-renderer.ts`:

5. Delete the dot block in `drawIconsTab` (the `// 3. Status dot...` comment and the `if (spec.dot) {...}` statement).
6. Delete `export const DOT_SIZE = 8` and the `/** Status dot: ... */` comment above `STATUS_GREEN` (replace with `/** Pane-icon tint colors (tab bar's text-success / text-blue-500). */`). Keep `STATUS_GREEN`/`STATUS_BLUE` — Task 10 uses them.
7. Renumber the remaining `drawIconsTab` step comments (banner becomes `// 3.`, rings `// 4.`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS. `npm run typecheck` — clean (`grep -rn "spec.dot\|DOT_SIZE" src/ test/` returns zero hits).

- [ ] **Step 7: Commit**

```bash
git add src/deck/frame.ts src/deck/tile-renderer.ts test/unit/client/deck/frame.test.ts test/unit/client/deck/tile-renderer.test.ts test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): replace the icons-tile status dot with paneIcons in the KeySpec"
```

---

### Task 10: Render tinted agent icons beside the repo icon (+N overflow badge)

Draw the tab bar's presentation on the key: repo icon (or circle letter avatar) first, then up to 2 tinted agent icons, then a `+N` badge for hidden agent panes (blue when a hidden pane is busy — TabItem's overflow rule). Tabs with no agent panes keep today's repo-icons-only row (up to 3). Tinted icons come from `providerIconDataUrl` through the injected `IconSource` (the real pipeline passes `IconImageCache.bitmapFor`, so async load + blank-draw probe + repaint-on-load all keep working; before the data URL decodes, the slot is simply empty for one frame).

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `spec.paneIcons: TilePaneIcon[]` (Task 9), `providerIconDataUrl` (Task 7), `STATUS_GREEN`/`STATUS_BLUE` (Task 6), `DECK_FONT_STACK` (Task 3).
- Produces:
  - `export const MAX_KEY_PANE_ICONS = 2`
  - `export const OVERFLOW_FONT_SIZE = 10`
  - `export const STATUS_AMBER = '#f59f0a'` (`--warning: hsl(38 92% 50%)`), `export const STATUS_RED = '#dc2828'` (`--destructive` light), `export const STATUS_MUTED = '#a1a1aa'` (`text-muted-foreground` dark), `export const STATUS_MUTED_DIM = 'rgba(161,161,170,0.4)'` (`text-muted-foreground/40`)
  - `export const PANE_TINT_COLORS: Record<TilePaneTint, string>`

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/tile-renderer.test.ts`, add imports (`MAX_KEY_PANE_ICONS`, `PANE_TINT_COLORS`, `STATUS_BLUE`, `STATUS_GREEN`, `STATUS_MUTED`, `OVERFLOW_FONT_SIZE` from `@/deck/tile-renderer`; `providerIconDataUrl` from `@/deck/provider-icon-svg`) and a new describe block. Note `renderTab`'s second parameter is the `IconSource`.

```ts
describe('agent pane icons (tab-bar presentation)', () => {
  const repoIcon = { url: null, letter: 'B', hue: 200, ready: false }
  const bitmap = {} as CanvasImageSource

  it('requests the tinted provider icon and draws it beside the repo avatar', () => {
    const requested: string[] = []
    const { images, circles } = renderTab(
      tabSpec({ icons: [repoIcon], paneIcons: [{ provider: 'claude', tint: 'blue' }] }),
      (url) => { requested.push(url); return bitmap },
    )
    expect(requested).toEqual([providerIconDataUrl('claude', STATUS_BLUE)])
    const slots = iconLayout(80, 80, 2)
    // Slot 0: letter avatar circle; slot 1: the tinted agent icon.
    expect(circles[0].cx).toBe(slots[0].x + slots[0].size / 2)
    expect(images).toEqual([{ x: slots[1].x, y: slots[1].y, w: slots[1].size, h: slots[1].size }])
  })

  it('caps drawn agent icons at MAX_KEY_PANE_ICONS and folds the rest into a +N badge', () => {
    const paneIcons = [
      { provider: 'claude', tint: 'green' as const },
      { provider: 'codex', tint: 'green' as const },
      { provider: 'gemini', tint: 'green' as const },
      { provider: 'opencode', tint: 'blue' as const },
    ]
    const requested: string[] = []
    const { texts } = renderTab(tabSpec({ icons: [repoIcon], paneIcons }), (url) => { requested.push(url); return bitmap })
    expect(requested).toEqual([
      providerIconDataUrl('claude', STATUS_GREEN),
      providerIconDataUrl('codex', STATUS_GREEN),
    ])
    const badge = texts.find((t) => t.text === '+2')
    expect(badge).toBeDefined()
    // A hidden pane is busy -> blue badge (TabItem's overflow rule).
    expect(badge?.style).toBe(STATUS_BLUE)
    expect(badge?.font).toBe(`600 ${OVERFLOW_FONT_SIZE}px ${DECK_FONT_STACK}`)
  })

  it('badge is muted when no hidden pane is busy', () => {
    const paneIcons = Array.from({ length: 3 }, () => ({ provider: 'claude', tint: 'green' as const }))
    const { texts } = renderTab(tabSpec({ icons: [], paneIcons }), () => bitmap)
    expect(texts.find((t) => t.text === '+1')?.style).toBe(STATUS_MUTED)
  })

  it('with agent icons present, repo icons collapse to the first one', () => {
    const icons = [repoIcon, { ...repoIcon, letter: 'C', hue: 10 }, { ...repoIcon, letter: 'D', hue: 20 }]
    const { circles } = renderTab(tabSpec({ icons, paneIcons: [{ provider: 'claude', tint: 'green' }] }), () => bitmap)
    expect(circles).toHaveLength(1) // only the first repo avatar
  })

  it('without agent panes, up to 3 repo icons render exactly as before', () => {
    const icons = [repoIcon, { ...repoIcon, letter: 'C', hue: 10 }, { ...repoIcon, letter: 'D', hue: 20 }]
    const { circles } = renderTab(tabSpec({ icons, paneIcons: [] }))
    expect(circles).toHaveLength(3)
  })

  it('an unloaded tinted icon draws nothing (slot fills on the cache-notify repaint)', () => {
    const { images } = renderTab(tabSpec({ icons: [], paneIcons: [{ provider: 'claude', tint: 'green' }] }), () => null)
    expect(images).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `MAX_KEY_PANE_ICONS` not exported; no data URLs requested.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts`:

1. Imports: `import { providerIconDataUrl } from './provider-icon-svg'` and `import type { TilePaneTint } from './deck-selectors'`.
2. Constants (in the palette block, with mapping comments in the same style as Task 6):

```ts
/** --warning: hsl(38 92% 50%) (text-warning). */
export const STATUS_AMBER = '#f59f0a'
/** --destructive light: hsl(0 72% 51%) (text-destructive). */
export const STATUS_RED = '#dc2828'
/** text-muted-foreground dark: hsl(240 5% 65%). */
export const STATUS_MUTED = '#a1a1aa'
/** text-muted-foreground/40 dark. */
export const STATUS_MUTED_DIM = 'rgba(161,161,170,0.4)'
/** TabItem.tsx pane-icon tint classes -> canvas colors. */
export const PANE_TINT_COLORS: Record<TilePaneTint, string> = {
  blue: STATUS_BLUE,
  green: STATUS_GREEN,
  amber: STATUS_AMBER,
  red: STATUS_RED,
  muted: STATUS_MUTED,
  mutedDim: STATUS_MUTED_DIM,
}
/** Agent icons drawn per key; hidden panes fold into the +N badge (TabItem rule, key-sized). */
export const MAX_KEY_PANE_ICONS = 2
export const OVERFLOW_FONT_SIZE = 10
```

3. In `drawIconsTab`, replace block `// 2.` (the repo-icons loop from Task 2) with the combined row:

```ts
  // 2. Center row mirrors the tab bar's pane-icon presentation (TabItem.tsx
  //    renderIcons): repo icon (or circle letter avatar) first, then up to
  //    MAX_KEY_PANE_ICONS tinted agent icons, then a +N badge for hidden agent
  //    panes (blue when a hidden pane is busy). Tabs with no agent panes keep
  //    the repo-icons-only row (up to 3, as before).
  const paneIcons = spec.paneIcons.slice(0, MAX_KEY_PANE_ICONS)
  const hidden = spec.paneIcons.slice(MAX_KEY_PANE_ICONS)
  const repoIcons = paneIcons.length > 0 ? spec.icons.slice(0, 1) : spec.icons
  const slots = iconLayout(w, h, repoIcons.length + paneIcons.length)
  repoIcons.forEach((icon, i) => {
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
    // Letter avatar: exact canvas replica of RepoIcon's SVG — circle filling
    // the slot, letter at 9/16 of the diameter, weight 600, white, with
    // RepoIcon's +0.5/16 optical nudge below true center (y=8.5 in a 16-unit box).
    const cx = x + size / 2
    const cy = y + size / 2
    ctx.fillStyle = repoAvatarColor(icon.hue)
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = `600 ${Math.round(size * REPO_AVATAR_FONT_RATIO)}px ${DECK_FONT_STACK}`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    const letterWidth = ctx.measureText(icon.letter).width
    ctx.fillText(icon.letter, Math.round(cx - letterWidth / 2), Math.round(cy + size * (0.5 / 16)))
  })
  paneIcons.forEach((icon, i) => {
    const { x, y, size } = slots[repoIcons.length + i]
    // Tinted agent icon via the icon cache: async decode + drawn-empty probe;
    // an unloaded slot stays empty until the cache-notify repaint. 5-arg
    // drawImage is mandatory (see the repo-icon comment above).
    const bitmap = getIcon(providerIconDataUrl(icon.provider, PANE_TINT_COLORS[icon.tint]))
    if (bitmap) ctx.drawImage(bitmap, x, y, size, size)
  })
  if (hidden.length > 0 && slots.length > 0) {
    const last = slots[slots.length - 1]
    ctx.font = `600 ${OVERFLOW_FONT_SIZE}px ${DECK_FONT_STACK}`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hidden.some((p) => p.tint === 'blue') ? STATUS_BLUE : STATUS_MUTED
    ctx.fillText(`+${hidden.length}`, last.x + last.size + ICON_GAP, last.y + last.size / 2)
  }
```

(This is the whole block — the Task 2 avatar code moves inside unchanged except the Task 4 font family.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: PASS (including the Task 9 "background + banner only" test — an empty `paneIcons` draws nothing new). `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): draw tab-bar-style tinted agent icons beside the repo icon with +N overflow"
```

---

### Task 11: End-to-end proof, full gates, and virtual-deck verification

Prove the production path end to end (store → selectors → frame → real assertions on the wire format), run every coordinated gate, and verify the shared-renderer virtual deck panel.

**Files:**
- Test: `test/e2e/stream-deck-flow.test.tsx`
- Possibly modify: `docs/index.html` (only if it depicts the old dot visuals)

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: Write the failing e2e test**

In `test/e2e/stream-deck-flow.test.tsx`, inside the `describe('tile styles')` block (added by commit `196f3e16`, ~line 460), add a full-pipeline test using the file's existing fixtures (`setup`/`makeDeckStore` with a busy pane — the fixture exposes a busy option; mirror how the neighboring `dot`-era tests marked a tab busy):

```tsx
it('icons style: busy agent pane surfaces as a blue-tinted paneIcon on the wire', () => {
  const { device } = setup({ tabs: 2, busy: ['term-2'] }) // adapt to the fixture's busy option
  const spec = decodeKey(device, 1) // the key showing tab t2 — adapt index to fixture sort order
  expect(spec).toMatchObject({
    kind: 'tab',
    style: 'icons',
    paneIcons: [{ provider: 'claude', tint: 'blue' }],
  })
})
```

(Adapt the option names, key index, and provider to the file's actual fixture — the pattern to copy is the former `dot: 'blue'` test updated in Task 9 at ~line 411. The load-bearing assertion is `paneIcons: [{ provider: <fixture mode>, tint: 'blue' }]` flowing from real store state.)

- [ ] **Step 2: Run to verify it exercises the pipeline**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS if Tasks 8-9 were correct (this is a proof test; if it fails, the failure is a real integration bug — fix the source, not the test).

- [ ] **Step 3: Virtual deck + docs check**

- Run: `npm run test:vitest -- run test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts` — the panel drives the REAL `renderKey`/`renderStrip` through `safeCtxFactory`/`noopCtx`; expected PASS (proves the shared renderer path executes the new drawing code without throwing).
- `grep -n "deck\|Stream Deck" docs/index.html` — if the docs depict the old dot/square-avatar visuals, update the wording minimally; otherwise leave untouched.
- OPTIONAL manual visual check (allowed without approval): `scripts/launch-rust.sh --client-only`, hard-refresh the browser, open Settings → the virtual deck panel, and confirm: circle avatars matching the tab bar's colors, Inter text after load, cohesive dark palette, tinted agent icons, no dot. Do NOT restart the server on port 3002; no broad kill patterns.

- [ ] **Step 4: Full gates**

```bash
npm run lint        # expected: clean
npm run typecheck   # expected: clean
FRESHELL_TEST_SUMMARY="deck icons polish final gate" npm test   # coordinated full suite; wait for the gate if held
```

Expected: all green. Fix anything that fails (likely candidates: a missed `DeckTab` literal without `paneIcons`, or a stray `dot:`/`DOT_` reference — `grep -rn "dot:" src/deck/ test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(deck): e2e proof of tinted paneIcons pipeline + final gates for icons polish"
```

(If nothing changed in Step 3's docs check, the commit contains only the e2e test — that is fine.)

---

## Self-Review Record

**1. Spec coverage:**
- Change 1 (circle avatar, shared algorithm/constants, same casing/proportions/white letter): Tasks 1-2 (import/share via `repoAvatarColor` + `REPO_AVATAR_FONT_RATIO` + already-shared `hueFromString`). ✓
- Change 2 (Inter everywhere on the deck: banner, avatar letters, pager, action, strip; local asset, no CDN; FontFace load + repaint; sans-serif fallback): Tasks 3-5. Preview tile pinned per the "previews unchanged" clause — decision documented in Global Constraints. ✓
- Change 3 (palette from app tokens, hue-preserving, documented mapping): Task 6 (+ Task 10's tint colors carry the same mapping comments). ✓
- Change 4 (dot removed; repo icon + tinted agent icons like the tab bar; cap/ordering/overflow adapted; canvas tinting; blank-draw detection preserved; tile-state untouched; no-agent tabs show repo icon only): Tasks 7-10, proven e2e in Task 11. ✓
- Scope/quality (previews untouched, sorting/interaction/settings unchanged, TDD, suites green, lint+typecheck, virtual deck verified, branch on origin/main): Global Constraints + Task 11. ✓

**1b. No silent deferrals:** No stubs or mocks stand in for production behavior. Canvas tests use the repo's established recorded-draw-call harness (the only possible approach — jsdom has no canvas), and Task 11's e2e test plus the VirtualDeckPanel suite prove the real store→wire→renderer path; the optional manual check covers real-pixel confirmation. Font loading is exercised against a real `FontFaceSet` contract with an injectable hook (production default `whenDeckFontReady` is itself unit-tested). No requirement was moved to future work.

**2. Placeholder scan:** No TBD/TODO/"similar to Task N"; every code step shows the code. The two places implementers must adapt to fixture internals (Task 9 Step 3, Task 11 Step 1) give the exact mechanical rule and the file locations, because the e2e fixture bodies are test-local details best read in place.

**3. Type consistency:** `repoAvatarColor(hue: number): string` / `REPO_AVATAR_FONT_RATIO` (T1) used in T2/T10; `Ctx2D` widened with `beginPath|arc|fill` (T2) matched by harness + `noopCtx`; `DECK_FONT_STACK` (T3) used in T4/T10; `fontReady?: (onReady: () => void) => () => void` (T5) matches `whenDeckFontReady`'s signature (T3); `STATUS_GREEN`/`STATUS_BLUE` (T6) used in T9/T10 tests and `PANE_TINT_COLORS`; `TilePaneTint`/`TilePaneIcon`/`getTabPaneIcons` (T8) consumed by T9 `KeySpec` and T10 renderer; `providerIconDataUrl(provider, colorHex)` (T7) called with `PANE_TINT_COLORS[tint]` (T10). Consistent.
