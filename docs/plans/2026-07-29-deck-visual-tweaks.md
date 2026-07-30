# Deck Visual Tweaks Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Four rendering-only visual tweaks to freshell's Stream Deck key images: regular-weight (400) title text, ~50% larger tile icons, subtle letter-spacing on deck text, and a rounded-rectangle frame with pure black outside on every key.

**Architecture:** All deck pixels flow through one file — `src/deck/tile-renderer.ts` — consumed identically by the physical WebHID deck and the in-app `VirtualDeckPanel` (both inject the same `renderKey`/`renderStrip`). Changes are made in the renderer only; the injectable-`Ctx2D` seam is extended once (type + two fake contexts) and every tweak is proven at the recorded-draw-call level in the existing `recordingCtx` harness (jsdom has no real canvas; pixel reads are impossible by design).

**Tech Stack:** TypeScript, HTML Canvas 2D, Vitest + jsdom with an injected recording context. The physical deck path is Chromium (WebHID requires it), but `VirtualDeckPanel`'s real-canvas path runs in whatever browser loads the web client (README advertises the panel for browsers without WebHID), so: `ctx.roundRect` is guarded at both real-ctx seams (Task 1's `ensureRoundRect` — square-corner degrade on pre-Baseline-2023 browsers: Firefox ≤111 / Safari ≤15); `ctx.letterSpacing` needs no guard (assigning it on a non-supporting canvas is an inert expando — no throw, and rendering stays self-consistent because `measureText` excludes the tracking there too). Chromium's trailing-inclusive `letterSpacing` measurement model (the basis of Task 5 and the test stub) was verified empirically in real headless Chromium 145 — see the assumption ledger at `.worktrees/.the-usual-logs/deck-visual-tweaks/load-bearing-ledger.md`.

## Global Constraints

- Client-only, rendering-only: no changes to sorting, selectors/state classification, interaction, settings, or transports.
- Branch is based on `origin/main` (worktree already created at `/home/dan/code/freshell/.worktrees/deck-visual-tweaks` by the workspace stage — all work happens there).
- Do NOT create or open a PR without explicit user approval.
- NEVER restart the live Rust server on port 3002; no broad kill patterns.
- Focused test runs use `npm run test:vitest -- run <path>` (the coordinator auto-injects the client vitest config; always pass `run` to avoid watch mode).
- Red-Green-Refactor TDD; frequent, focused conventional commits (`feat(deck): ...`, `test(deck): ...`).
- The classic terminal-previews tile style is PINNED (source comment `tile-renderer.ts:60-61`, tests "classic preview tile is PINNED..." and "classic previews palette is PINNED"): it may be touched ONLY for the rounded-frame change (Task 2/3). Its fonts (`11px monospace`, `${TITLE_FONT_SIZE}px sans-serif`), palette, content, and truncation behavior stay identical — no weight token, no letterSpacing, no maxWidth change.
- Inter is bundled with ONLY weights 400 and 600 (`src/deck/deck-font.ts`). Use no other weight anywhere.
- The deck letter avatar is a documented bidirectional mirror of the app's `RepoIcon` (`src/components/icons/RepoIcon.tsx:69`, `fontWeight="600"`). It stays weight 600. The `+N` badge stays 600 for the same reason (tiny text, avatar-adjacent).
- Three `Ctx2D` implementations must stay in lockstep: the `Ctx2D` type (`src/deck/tile-renderer.ts`), production `noopCtx` (`src/components/VirtualDeckPanel.tsx`), and the test `recordingCtx` (`test/unit/client/deck/tile-renderer.test.ts`).
- `test/setup/dom.ts` makes any `console.error` fatal in tests — new tests must not produce console errors.
- `docs/plans/` docs are working/agent docs; do not add other end-user markdown.

## Settled Design Decisions (do not re-litigate)

| # | Tweak | Decision |
|---|---|---|
| 1 | Unbold headings | Icons-style banner title, pager page-count value, and action-key labels go 600 → 400. Letter avatar and `+N` badge KEEP 600 (RepoIcon mirror). Classic preview banner already has no weight token (renders regular) — untouched. Strip and pager labels already 400. Resulting rule, documented in code: *600 only where the deck mirrors the app UI (avatar, badge); 400 everywhere else.* |
| 2 | Icons ~50% larger | `iconLayout` scales: `0.5 → 0.75` (count===1), `0.3 → 0.45` (count>=2), plus a row-fit clamp so multi-icon rows never overflow the rounded frame (`ICON_ROW_SIDE_INSET = 6`). `+N` badge font becomes slot-proportional: `max(OVERFLOW_FONT_SIZE, round(slot.size / 2))`. |
| 3 | Letter spacing | `TEXT_LETTER_SPACING = '0.4px'` applied to: icons-style banner title, pager labels + value, action labels, touch-strip text. NOT applied to: classic preview (pinned), avatar letter (single glyph, RepoIcon mirror), `+N` badge. `letterSpacing` is set BEFORE measuring so `fitLabel` accounts for it (Chromium's `measureText` includes tracking). Icons-banner `fitLabel` maxWidth tightens from `w - 4` to `w - 12` to clear the rounded corners. The ~0.2px centering skew from Chromium's trailing tracking is accepted (not corrected) — it is below device resolution. |
| 4 | Rounded keys | Every key kind (empty, tab-icons, tab-preview, pager, action) fills the full canvas pure black (`EMPTY_BG`), then clips all content to a rounded rect: `margin = 3` (keys < 96px) or `4` (>= 96px), `radius = round(min(w,h) * 0.12)` → 72px:(3,9), 80px:(3,10), 96px:(4,12), 120px:(4,14). All rings/borders (`drawRing`: green barTop ring, white active ring, classic status rings, action rings) become rounded-rect STROKES that follow the frame. The touch strip is an LCD, not a key — it is NOT framed (its background is already black). The empty key's interior stays `EMPTY_BG` (pixels unchanged; code path uniform). |

Reference geometry (used throughout the tasks):

| Key | keyFrameGeometry | iconLayout count=1 (size, x, y) | count=2 size | count=3 size |
|---|---|---|---|---|
| 72×72 | margin 3, radius 9 | 39 | 23 | 18 (clamped) |
| 80×80 | margin 3, radius 10 | 45, x=18, y=28 | 27 | 20 (clamped) |
| 96×96 | margin 4, radius 12 | 57 | 34 | 26 (clamped) |
| 120×120 | margin 4, radius 14 | 75 | 45 | 34 (clamped) |

---

### Task 1: Extend the Ctx2D contract and all three context implementations

Pure scaffolding for Tasks 2–6: the renderer's narrow `Ctx2D` type gains the members the tweaks need (`save`/`restore`/`clip`/`stroke`/`roundRect`/`strokeStyle`/`lineWidth`/`letterSpacing`), both fake contexts (production `noopCtx`, test `recordingCtx`) are extended in lockstep, and a tiny `ensureRoundRect` compatibility guard is installed at both real-ctx seams. No behavior change; the gate is typecheck + suite green. (No RED phase — this task adds unused capability plus one directly-tested compatibility guard; every later task drives the rest through failing tests.)

**Files:**
- Modify: `src/deck/tile-renderer.ts` (the `Ctx2D` type at lines ~12-15 and `defaultCtxFactory` at ~348-355)
- Modify: `src/components/VirtualDeckPanel.tsx` (`noopCtx`, lines ~22-36)
- Test: `test/unit/client/deck/tile-renderer.test.ts` (`recordingCtx` harness, lines ~17-55, and the render-helper wrappers at ~110-119)

**Interfaces:**
- Consumes: existing `Ctx2D` type and the three implementations listed above.
- Produces (relied on by Tasks 2–6):
  - `Ctx2D` includes: `save(): void`, `restore(): void`, `clip(): void`, `stroke(): void`, `roundRect(x: number, y: number, w: number, h: number, radii?: number): void`, `strokeStyle: string | CanvasGradient | CanvasPattern`, `lineWidth: number`, `letterSpacing: string` (plus everything it had).
  - `recordingCtx(...)` additionally returns `clips: Array<{ x: number; y: number; w: number; h: number; r: number }>`, `strokes: Array<{ x: number; y: number; w: number; h: number; r: number; style: string; lineWidth: number }>`, `measures: Array<{ text: string; letterSpacing: string }>`; its `Text` records gain `letterSpacing: string`; its `measureText` returns `t.length * (6 + parsedLetterSpacing)`. (This trailing-inclusive model was verified against real Chromium 145: `measureText` adds the tracking after EVERY glyph including the last, and assigning `font` after `letterSpacing` does not reset the spacing — see the assumption ledger.)
  - `export function ensureRoundRect(ctx: CanvasRenderingContext2D): void` — applied inside `defaultCtxFactory` (tile-renderer) and `safeCtxFactory` (VirtualDeckPanel): polyfills a missing `roundRect` with a square-corner `rect()` delegate so pre-Baseline-2023 browsers (Firefox ≤111, Safari ≤15) degrade instead of throwing.

- [ ] **Step 1: Extend the `Ctx2D` type in `src/deck/tile-renderer.ts`**

Replace the existing type (currently `Pick<CanvasRenderingContext2D, 'fillRect' | 'fillText' | 'measureText' | 'getImageData' | 'drawImage' | 'beginPath' | 'arc' | 'fill'> & { fillStyle...; font...; textBaseline... }`) with:

```ts
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'getImageData'
  | 'drawImage'
  | 'beginPath'
  | 'arc'
  | 'fill'
  | 'save'
  | 'restore'
  | 'clip'
  | 'stroke'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  /** Chromium-only canvas API (the deck runs in Chromium/Electron; WebHID requires it). */
  letterSpacing: string
  textBaseline: CanvasTextBaseline
  roundRect(x: number, y: number, w: number, h: number, radii?: number): void
}
```

- [ ] **Step 2: Make `defaultCtxFactory` satisfy the new type**

In `defaultCtxFactory` (same file), change the final `return ctx` to:

```ts
  // lib.dom may predate ctx.letterSpacing; the runtime (Chromium) always has it.
  return ctx as unknown as Ctx2D
```

- [ ] **Step 3: Guard `roundRect` at both real-ctx seams (`ensureRoundRect`)**

Validation FALSIFIED the assumption that every real 2D context has `roundRect`: it is
Baseline 2023 (Chrome/Edge 99+, Firefox 112+, Safari 16+), and `VirtualDeckPanel`'s
`safeCtxFactory` hands the renderer a REAL ctx in any browser where `getContext('2d')`
succeeds (the README advertises the virtual deck panel for browsers without WebHID; a
missing `roundRect` would throw uncaught through `DeckController.render`). Add to
`src/deck/tile-renderer.ts`, next to `defaultCtxFactory`:

```ts
/** Pre-Baseline-2023 canvases (Firefox <=111, Safari <=15) lack roundRect; an
 * unguarded call would crash VirtualDeckPanel rendering in those browsers.
 * Degrade to square corners instead. (ctx.letterSpacing needs no guard:
 * assigning it on a non-supporting canvas is an inert expando — no throw, and
 * text stays self-consistent since measureText excludes the tracking there too.) */
export function ensureRoundRect(ctx: CanvasRenderingContext2D): void {
  const c = ctx as CanvasRenderingContext2D & { roundRect?: unknown }
  if (typeof c.roundRect !== 'function') {
    c.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
      this.rect(x, y, w, h)
    }
  }
}
```

Call `ensureRoundRect(ctx)` in `defaultCtxFactory` immediately before Step 2's
`return`, and in `safeCtxFactory` (`src/components/VirtualDeckPanel.tsx`) on the real
ctx before it is returned (the `noopCtx` fallback branch defines `roundRect` itself and
needs nothing).

Add one unit test in `test/unit/client/deck/tile-renderer.test.ts` near the harness:
calling `ensureRoundRect` on a stub `{ rect: <recorder> }` WITHOUT `roundRect` installs
a `roundRect` that delegates x/y/w/h to `rect` (radius dropped); calling it on a stub
WITH a `roundRect` function leaves that function untouched.

- [ ] **Step 4: Extend `noopCtx` in `src/components/VirtualDeckPanel.tsx`**

Add these members to the object literal returned by `noopCtx` (keep every existing member):

```ts
    strokeStyle: '',
    lineWidth: 0,
    letterSpacing: '',
    save: () => {},
    restore: () => {},
    clip: () => {},
    stroke: () => {},
    roundRect: () => {},
```

- [ ] **Step 5: Extend `recordingCtx` in `test/unit/client/deck/tile-renderer.test.ts`**

Update the record types and the harness. `Text` gains `letterSpacing`; new `clips`/`strokes`/`measures` arrays; `measureText` models Chromium's tracking (spacing added after every char, including the last):

```ts
type Rect = { x: number; y: number; w: number; h: number; style: string }
type Text = { text: string; x: number; y: number; style: string; font: string; letterSpacing: string }
type Img = { x: number; y: number; w: number; h: number }
type Circle = { cx: number; cy: number; r: number; style: string }
type RRect = { x: number; y: number; w: number; h: number; r: number }
type Stroke = RRect & { style: string; lineWidth: number }
type Measure = { text: string; letterSpacing: string }

function recordingCtx(width: number, height: number) {
  const rects: Rect[] = []
  const texts: Text[] = []
  const images: Img[] = []
  const circles: Circle[] = []
  const clips: RRect[] = []
  const strokes: Stroke[] = []
  const measures: Measure[] = []
  let pendingArc: { cx: number; cy: number; r: number } | null = null
  let pendingRound: RRect | null = null
  const ctx = {
    fillStyle: '#000000' as string,
    strokeStyle: '#000000' as string,
    lineWidth: 0,
    font: '',
    letterSpacing: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, style: String(this.fillStyle) })
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, style: String(this.fillStyle), font: this.font, letterSpacing: this.letterSpacing })
    },
    drawImage(_src: CanvasImageSource, x: number, y: number, w: number, h: number) {
      images.push({ x, y, w, h })
    },
    beginPath() {
      pendingArc = null
      pendingRound = null
    },
    arc(cx: number, cy: number, r: number) {
      pendingArc = { cx, cy, r }
    },
    roundRect(x: number, y: number, w: number, h: number, r = 0) {
      pendingRound = { x, y, w, h, r }
    },
    clip() {
      if (pendingRound) clips.push(pendingRound)
      pendingRound = null
    },
    stroke() {
      if (pendingRound) strokes.push({ ...pendingRound, style: String(this.strokeStyle), lineWidth: this.lineWidth })
      pendingRound = null
    },
    fill() {
      if (pendingArc) circles.push({ ...pendingArc, style: String(this.fillStyle) })
      pendingArc = null
    },
    save() {},
    restore() {},
    measureText(t: string) {
      measures.push({ text: t, letterSpacing: this.letterSpacing })
      const ls = parseFloat(this.letterSpacing) || 0
      return { width: t.length * (6 + ls) } as TextMetrics
    },
    getImageData() {
      return { data: new Uint8ClampedArray(width * height * 4) } as ImageData
    },
  } as unknown as Ctx2D
  return { ctx, rects, texts, images, circles, clips, strokes, measures }
}
```

Then update the per-test render-helper wrapper(s) just below (lines ~110-119, plus the inline pager/action/strip variants at ~196-212 and ~263-271) following their existing pattern so the returned record object passes through `clips`, `strokes`, and `measures` (if a wrapper already returns the whole `recordingCtx(...)` result, no change is needed there).

- [ ] **Step 6: Verify no behavior changed**

Run: `npm run typecheck`
Expected: PASS (if it errors ONLY on `letterSpacing` not existing on `CanvasRenderingContext2D`, the Step 2 cast is missing — apply it).

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS (all existing tests green plus the new `ensureRoundRect` unit test; nothing else exercises the new members yet).

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/deck/tile-renderer.ts src/components/VirtualDeckPanel.tsx test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): extend Ctx2D contract with clip/stroke/roundRect/letterSpacing across all three context impls"
```

---

### Task 2: Rounded-rectangle key frame with black surround (tweak 4, part 1)

Every key kind fills the canvas pure black, then clips ALL content to a rounded rect. `renderKey` owns the frame so all five kinds (empty/tab-icons/tab-preview/pager/action) get it uniformly; the classic preview style is touched only by this frame (its content drawing is untouched). The touch strip (`renderStrip`) is NOT framed.

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: Task 1's `Ctx2D` members (`save`, `roundRect`, `clip`, `restore`) and harness `clips` array.
- Produces (relied on by Task 3 and 6):
  - `export function keyFrameGeometry(w: number, h: number): { margin: number; radius: number }` — margin 3 below 96px else 4; radius `Math.round(Math.min(w, h) * KEY_FRAME_RADIUS_RATIO)`.
  - `export const KEY_FRAME_RADIUS_RATIO = 0.12`
  - Draw-call order per key: `rects[0]` is the full-bleed black surround, `clips[0]` is the frame, then the key's own content (so the key's background fill is now `rects[1]`).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/client/deck/tile-renderer.test.ts` (import `keyFrameGeometry` and `EMPTY_BG` from the renderer module alongside the existing imports; use the file's existing spec builders — `previewSpec` and the icons-style builder defined next to it at ~:97-108 — and render helpers):

```ts
describe('rounded key frame', () => {
  it('keyFrameGeometry: margin 3 below 96px (else 4), radius 12% of key size', () => {
    expect(keyFrameGeometry(72, 72)).toEqual({ margin: 3, radius: 9 })
    expect(keyFrameGeometry(80, 80)).toEqual({ margin: 3, radius: 10 })
    expect(keyFrameGeometry(96, 96)).toEqual({ margin: 4, radius: 12 })
    expect(keyFrameGeometry(120, 120)).toEqual({ margin: 4, radius: 14 })
  })

  it('every key kind paints a pure-black surround then clips to the rounded frame', () => {
    // Render one spec of each kind through the existing helpers and collect the records.
    // 80x80 caps => frame margin 3, radius 10, inner 74x74.
    for (const rec of [
      renderKeyKind({ kind: 'empty' }),          // adapt to the file's helper names
      renderKeyKind(iconsSpec({})),
      renderKeyKind(previewSpec({})),
      renderKeyKind(pagerSpec()),
      renderKeyKind(actionSpec()),
    ]) {
      expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: EMPTY_BG })
      expect(rec.clips[0]).toEqual({ x: 3, y: 3, w: 74, h: 74, r: 10 })
    }
  })
})
```

(`renderKeyKind`/`iconsSpec`/`pagerSpec`/`actionSpec` are stand-ins: reuse the file's existing wrapper that calls `renderKey(spec, MINI_CAPS-equivalent caps, factory)` and its existing spec builders for tab/pager/action — those four kinds are already rendered somewhere in this file; follow those call sites exactly. NOTE: `kind: 'empty'` is NOT currently rendered anywhere in the test file — this frame test introduces the first empty-kind render; build the spec inline as `{ kind: 'empty' }` and pass it through the same wrapper.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts -t 'rounded key frame'`
Expected: FAIL — `keyFrameGeometry` is not exported / `clips` is empty.

- [ ] **Step 3: Implement the frame in `src/deck/tile-renderer.ts`**

Add next to the other exported constants:

```ts
/** Rounded key frame: every key draws inside a rounded rect with pure black
 * outside it, so each button reads as a rounded tile floating on the deck. */
export const KEY_FRAME_RADIUS_RATIO = 0.12

export function keyFrameGeometry(w: number, h: number): { margin: number; radius: number } {
  const s = Math.min(w, h)
  return { margin: s >= 96 ? 4 : 3, radius: Math.round(s * KEY_FRAME_RADIUS_RATIO) }
}

function beginKeyFrame(ctx: Ctx2D, w: number, h: number): void {
  ctx.fillStyle = EMPTY_BG
  ctx.fillRect(0, 0, w, h)
  const { margin, radius } = keyFrameGeometry(w, h)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(margin, margin, w - 2 * margin, h - 2 * margin, radius)
  ctx.clip()
}
```

In `renderKey`, wrap the existing switch (the switch body itself is unchanged — the empty case keeps its `EMPTY_BG` fill, now clipped and pixel-identical):

```ts
  const ctx = createCtx(w, h)
  beginKeyFrame(ctx, w, h)
  switch (spec.kind) {
    // ... existing cases, unchanged ...
  }
  ctx.restore()
  return ctx.getImageData(0, 0, w, h).data
```

`renderStrip` is NOT changed.

- [ ] **Step 4: Update existing tests broken by the new leading rect**

Every rendered key now records one extra leading rect (the black surround). In `test/unit/client/deck/tile-renderer.test.ts`:
- `'no status dot: a plain icons tile draws only the background and the banner'` (~:178-182): `expect(rects).toHaveLength(2)` → `toHaveLength(3)`; the background assertion moves from `rects[0]` to `rects[1]` (banner is `rects[2]`). Update the test name to mention the frame surround.
- `rects[0]`-is-background assertions at ~:125, ~:134, ~:139 (tab tiles) and ~:200 (pager `CONTROL_BG`): shift to `rects[1]`.
- There is NO pre-existing empty-key render test (the frame test in Step 1 introduces the first `kind: 'empty'` render). In that new test, for the empty kind expect TWO full-bleed `EMPTY_BG` rects: `rects[0]` (the frame surround) and `rects[1]` (the empty case's own fill, now clipped and pixel-identical).
- Any other test indexing `rects[0]`/counting rects for a rendered key: shift by one. Tests that call `drawRing`/`iconLayout`/`fitLabel` directly are unaffected.

- [ ] **Step 5: Run the full renderer suite**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): render every key inside a rounded-rect frame with pure black surround"
```

---

### Task 3: Rings and borders follow the rounded shape (tweak 4, part 2)

`drawRing` currently paints `width` nested 1px square `fillRect` frames. Replace with a single rounded-rect stroke inset from the frame. All 8 call sites (icons barTop green ring, white active rings, classic status rings, action rings) keep their exact signatures — one rewrite covers every border.

**Files:**
- Modify: `src/deck/tile-renderer.ts` (`drawRing`, lines ~125-134)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: Task 2's `keyFrameGeometry`; Task 1's `strokes` harness array and `strokeStyle`/`lineWidth`/`stroke` ctx members.
- Produces: `drawRing(ctx, w, h, color, width, inset = 0)` — SAME exported signature, new behavior: one rounded stroke at `off = margin + inset + width / 2`, radius `Math.max(1, radius - inset - width / 2)`. Rings appear in `strokes`, never in `rects`.

- [ ] **Step 1: Write the failing test**

Replace the existing `drawRing` unit test (`'paints width nested 1px frames at the given inset'`, ~:70-79) with:

```ts
  it('drawRing strokes a rounded rect that follows the key frame', () => {
    const rec = recordingCtx(80, 80)
    drawRing(rec.ctx, 80, 80, '#ffffff', 3, 0)
    // margin 3, radius 10 => off = 3 + 0 + 1.5 = 4.5, r = 10 - 1.5 = 8.5
    expect(rec.strokes[0]).toEqual({ x: 4.5, y: 4.5, w: 71, h: 71, r: 8.5, style: '#ffffff', lineWidth: 3 })
    expect(rec.rects).toHaveLength(0)

    const inner = recordingCtx(80, 80)
    drawRing(inner.ctx, 80, 80, '#ffffff', 2, 3)
    // off = 3 + 3 + 1 = 7, r = 10 - 3 - 1 = 6
    expect(inner.strokes[0]).toEqual({ x: 7, y: 7, w: 66, h: 66, r: 6, style: '#ffffff', lineWidth: 2 })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts -t 'drawRing strokes a rounded rect'`
Expected: FAIL — `strokes` is empty (rings still land in `rects`).

- [ ] **Step 3: Rewrite `drawRing`**

```ts
/** Ring/border that follows the rounded key frame: a rounded-rect stroke of
 * `width` px, `inset` px inside the frame edge. (Replaces the old nested
 * 1px square fillRect frames — strokes keep the rounded shape at corners.) */
export function drawRing(ctx: Ctx2D, w: number, h: number, color: string, width: number, inset = 0): void {
  const { margin, radius } = keyFrameGeometry(w, h)
  const off = margin + inset + width / 2
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.roundRect(off, off, w - 2 * off, h - 2 * off, Math.max(1, radius - inset - width / 2))
  ctx.stroke()
}
```

- [ ] **Step 4: Update ring assertions in rendered-key tests**

Every test that previously located ring `fillRect`s in `rects` (icons-tile barTop/active tests ~:128, ~:140-142, ~:147; classic ring tests ~:210-211, ~:224-225, ~:230 — locate by searching the test file for `BAR_TOP_BORDER`, `ACTIVE_COLOR`, and `RING_COLORS` assertions) must now assert against `strokes`:
- barTop green ring (`drawRing(..., BAR_TOP_BORDER, 3, 0)` on 80px): `strokes` contains `{ x: 4.5, y: 4.5, w: 71, h: 71, r: 8.5, style: BAR_TOP_BORDER, lineWidth: 3 }`.
- white active ring width 3 inset 0: same geometry with `style: ACTIVE_COLOR`.
- white active ring width 2 inset 3 (barTop+active and classic ring+active cases): `{ x: 7, y: 7, w: 66, h: 66, r: 6, style: ACTIVE_COLOR, lineWidth: 2 }`.
- classic status ring width 4 inset 0: `{ x: 5, y: 5, w: 70, h: 70, r: 8, style: RING_COLORS[<color>], lineWidth: 4 }`.
- Tests that asserted "no ring" by rect-count now assert `strokes` is empty (adjust counts accordingly — rings no longer add rects).

- [ ] **Step 5: Run the full renderer suite**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): rings and borders stroke rounded rects that follow the key frame"
```

---

### Task 4: Regular-weight (400) headings and controls (tweak 1)

Unbold the icons-style banner title, pager page-count value, and action-key labels: 600 → 400. Avatar letter and `+N` badge stay 600 (RepoIcon mirror); classic preview stays pinned and untouched.

**Files:**
- Modify: `src/deck/tile-renderer.ts` (three font strings: icons banner ~:254, pager value ~:286, action label ~:302)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: font strings `` `400 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}` `` (banner), `` `400 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` `` (pager value, action label). Avatar/badge font strings unchanged.

- [ ] **Step 1: Update the pinned-weight tests to the new expectations (these become the failing tests)**

In `test/unit/client/deck/tile-renderer.test.ts`:

Rename and update the test at ~:240-249 (`'icons tile: banner title and avatar letter render in 600-weight Inter'`) — keep its structure, change the expectations:

```ts
  it('icons tile: banner title renders regular-weight (400) Inter; avatar letter keeps RepoIcon 600', () => {
    // ...existing render of an icons tile with a letter avatar...
    expect(title?.font).toBe(`400 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`)
    const slot = iconLayout(80, 80, 1)[0] // derive, don't hardcode — Task 6 changes this size
    expect(letter?.font).toBe(`600 ${Math.round(slot.size * (9 / 16))}px ${DECK_FONT_STACK}`)
  })
```

(Note on ordering: this plan lands Task 4 before Task 6, so `iconLayout(80, 80, 1)[0].size` is still 30 here → `600 17px ...`; after Task 6 the same derived assertion yields `600 25px ...` without edits. The existing test at ~:160-176 already derives from `iconLayout`; mirror that.)

Update the pager test (~:251-...) `'pager: dim labels are 400 Inter, the page count is 600 Inter'` → `'pager: labels and page count render 400 Inter'`; the value expectation becomes `` `400 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``.

Update the action test `'action key labels render in 600 Inter'` → `'action key labels render in 400 Inter'` with `` `400 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``.

Leave untouched: the `+N` badge `600 10px` assertion (~:339), the avatar-600 assertion (~:175), the strip `400` test, and BOTH pinned classic tests (~:273-277, ~:298-302).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: FAIL — the three updated tests report `600 ...` received where `400 ...` expected.

- [ ] **Step 3: Implement the weight changes**

In `src/deck/tile-renderer.ts`, change exactly three font strings and add the rule as a comment where the banner font is set:

```ts
  // Weight rule: 400 everywhere, EXCEPT where the deck mirrors the app UI —
  // the letter avatar and +N badge keep RepoIcon's 600 (see RepoIcon.tsx).
  ctx.font = `400 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`
```

- pager value: `` ctx.font = `400 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``
- action label: `` ctx.font = `400 ${CONTROL_VALUE_FONT_SIZE}px ${DECK_FONT_STACK}` ``

Do NOT touch: avatar (`600 ${Math.round(size * REPO_AVATAR_FONT_RATIO)}px ...`), badge (`600 ${OVERFLOW_FONT_SIZE}px ...`), classic preview fonts, pager labels, strip.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS. Also check the `describe` block name containing these tests — if it says "600-weight Inter", rename it to describe the weight rule.

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): regular-weight titles and controls; avatar and badge keep RepoIcon 600"
```

---

### Task 5: Subtle letter spacing on deck text (tweak 3)

`TEXT_LETTER_SPACING = '0.4px'` on the icons banner, pager, action, and strip text — set BEFORE measurement so `fitLabel` accounts for it. Icons-banner maxWidth tightens to `w - 12` to clear the rounded corners. Classic preview, avatar letter, and `+N` badge keep default spacing.

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: Task 1's `letterSpacing` ctx member, `measures` array, and tracking-aware `measureText` stub.
- Produces:
  - `export const TEXT_LETTER_SPACING = '0.4px'`
  - `export const TITLE_SIDE_PADDING = 6` (icons banner `fitLabel` maxWidth = `w - 2 * TITLE_SIDE_PADDING`)

- [ ] **Step 1: Write the failing tests**

```ts
describe('letter spacing', () => {
  it('icons banner, pager, action, and strip text carry TEXT_LETTER_SPACING; avatar, badge, and classic preview do not', () => {
    // icons tile with letter avatar + hidden-pane badge:
    // title text  => letterSpacing '0.4px'
    // avatar char => letterSpacing ''
    // '+N' badge  => letterSpacing ''
    // pager: all three texts => '0.4px'
    // action: label => '0.4px'
    // strip: text => '0.4px'
    // classic preview: body lines AND banner => ''
    // (render each through the existing helpers, then assert texts[i].letterSpacing)
  })

  it('the icons title is measured with spacing applied and fits within w - 12', () => {
    // 72px-wide caps: maxWidth = 60; stub width = chars * 6.4 once spacing is set.
    // A 10-char title (10 * 6.4 = 64 > 60) must truncate: 'ABCDEFGHIJ' -> 'ABCDEFGH…' (9 * 6.4 = 57.6).
    const caps = { ...MINI_CAPS, keyPixelWidth: 72, keyPixelHeight: 72 }
    const rec = recordingCtx(72, 72)
    renderKey(iconsSpecWithTitle('ABCDEFGHIJ'), caps, () => rec.ctx)
    const title = rec.texts.find((t) => t.text.includes('…'))
    expect(title?.text).toBe('ABCDEFGH…')
    // measurement happened WITH the spacing already set:
    expect(rec.measures.find((m) => m.text === 'ABCDEFGHIJ')?.letterSpacing).toBe(TEXT_LETTER_SPACING)
  })
})
```

(Adapt spec construction to the file's existing builders; on the 80px key the same 10-char title still fits: `64 <= 80 - 12`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts -t 'letter spacing'`
Expected: FAIL — recorded `letterSpacing` is `''` everywhere and the 10-char title renders untruncated.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts` add:

```ts
/** Subtle tracking for deck text. Chromium-only canvas API — the deck's only
 * supported surface. Set BEFORE measureText so fitLabel includes the tracking
 * (Chromium adds it after every glyph, matching the test stub's model). */
export const TEXT_LETTER_SPACING = '0.4px'
/** Side padding for the icons-style banner label inside the rounded frame. */
export const TITLE_SIDE_PADDING = 6
```

In `drawIconsTab`, at the banner block (AFTER icons/avatar/badge are drawn — they must keep default spacing), set spacing before the font/measure and tighten maxWidth:

```ts
  ctx.fillStyle = BANNER_FILL
  ctx.fillRect(0, 0, w, BANNER_HEIGHT)
  ctx.letterSpacing = TEXT_LETTER_SPACING
  // Weight rule: 400 everywhere, EXCEPT where the deck mirrors the app UI —
  // the letter avatar and +N badge keep RepoIcon's 600 (see RepoIcon.tsx).
  ctx.font = `400 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 2 * TITLE_SIDE_PADDING)
  drawCenteredText(ctx, label, w, 2)
```

In `drawPager` and `drawAction`: add `ctx.letterSpacing = TEXT_LETTER_SPACING` immediately after the background fill (covers all their text). In `renderStrip`: add it before the font is set. Do NOT set it in `drawPreviewTab` (pinned classic — fresh ctx per key means it stays at the default `''`), and do not set it before the avatar/badge draws.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS. If any pre-existing centered-title x-position assertion breaks, recompute with the tracking-aware stub width (`chars * 6.4`).

- [ ] **Step 5: Typecheck + lint, then commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): subtle letter spacing on deck text, measured into title fitting"
```

---

### Task 6: ~50% larger tile icons with row-fit clamp; slot-proportional +N badge (tweak 2)

`iconLayout` scales go 0.75 (single) / 0.45 (multi) with a clamp so multi-icon rows always fit inside the rounded frame; the `+N` badge font scales with its slot.

**Files:**
- Modify: `src/deck/tile-renderer.ts` (`iconLayout` ~:113-123, badge font in `drawIconsTab` ~:245, `MAX_ROW_SLOTS` doc comment ~:81-85)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `keyFrameGeometry` (frame the row must clear), existing `ICON_GAP = 3`, `BANNER_HEIGHT = 20`, `OVERFLOW_FONT_SIZE = 10`.
- Produces:
  - `export const ICON_ROW_SIDE_INSET = 6`
  - `iconLayout(w, h, count)` — same signature/return type; new sizes per the reference table (80px: single 45 at x=18/y=28; pairs 27; triples clamped to 20).
  - Badge font: `` `600 ${Math.max(OVERFLOW_FONT_SIZE, Math.round(slot.size / 2))}px ${DECK_FONT_STACK}` ``

- [ ] **Step 1: Write the failing tests**

Replace the literal numbers in the `iconLayout` test (~:184-194) and add clamp + badge coverage:

```ts
  it('iconLayout: 1 icon centered ~50% larger; 3 icons clamp to fit inside the rounded frame', () => {
    const one = iconLayout(80, 80, 1)
    expect(one[0].size).toBe(45) // round(min(80, 60) * 0.75)
    expect(one[0].x).toBe(Math.round((80 - 45) / 2)) // 18
    expect(one[0].y).toBe(Math.round(20 + (60 - 45) / 2)) // 28
    expect(one[0].y).toBeGreaterThanOrEqual(BANNER_HEIGHT) // clear of the banner

    const two = iconLayout(80, 80, 2)
    expect(two.every((s) => s.size === 27)).toBe(true) // round(60 * 0.45), fits unclamped

    const three = iconLayout(80, 80, 3)
    expect(three.every((s) => s.size === 20)).toBe(true) // clamped: floor((80 - 12 - 2*3) / 3)
    expect(three[1].x - three[0].x).toBe(20 + 3) // size + gap
    const last = three[2]
    expect(last.x + last.size).toBeLessThanOrEqual(80 - ICON_ROW_SIDE_INSET) // on-frame guarantee

    const threeSmall = iconLayout(72, 72, 3)
    expect(threeSmall.every((s) => s.size === 18)).toBe(true) // floor((72 - 12 - 6) / 3)
    expect(threeSmall[0].x).toBeGreaterThanOrEqual(ICON_ROW_SIDE_INSET)
  })

  it('+N badge font scales with its slot', () => {
    // Render an icons tile with 1 repo icon + 3 agent panes on the 80px key:
    // arbitration yields repo + 1 agent + badge = 3 slots of size 20 => badge font stays max(10, 10) = 10.
    // Render with 0 repo icons + 3 agent panes: 2 drawn agents + badge = 3 slots (size 20) — same.
    // Render with 1 repo icon + panes hidden into a 2-slot row if reachable, else assert the formula
    // directly: badge.font === `600 ${Math.max(OVERFLOW_FONT_SIZE, Math.round(slot.size / 2))}px ${DECK_FONT_STACK}`
    // where slot is the LAST iconLayout slot for the rendered count.
  })
```

Concretely for the badge test: reuse the existing `'folds hidden agent icons into a +N badge...'` scenario (~:322-348), recompute its numbers from the new `iconLayout(80, 80, 3)` → slots at x = 7, 30, 53, y = 40, size = 20; badge slot `{x: 53, y: 40, size: 20}`; `'+2'` stub width 12 → badge x = `Math.round(53 + (20 - 12) / 2)` = 57, y = `40 + 10` = 50; font `'600 10px Inter, sans-serif'` (floor case). Change its on-key guard to the frame guard: `expect(badge.x + 12).toBeLessThanOrEqual(80 - ICON_ROW_SIDE_INSET)`. Then add one direct assertion of the scaling branch using a large slot, e.g. via `iconLayout(120, 120, 2)` (slot 45 → font `600 23px ...`) if a 120px render helper exists, else assert through a `PLUS_CAPS` render.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts -t 'iconLayout'`
Expected: FAIL — sizes still 30/18; badge font fixed 10px.

- [ ] **Step 3: Implement**

Replace `iconLayout`:

```ts
/** Keeps multi-icon rows clear of the rounded key frame's corners/edges. */
export const ICON_ROW_SIDE_INSET = 6

/** Centered icon slots in the area below the title banner. */
export function iconLayout(w: number, h: number, count: number): Array<{ x: number; y: number; size: number }> {
  if (count <= 0) return []
  const areaTop = BANNER_HEIGHT
  const areaH = h - areaTop
  const scale = count === 1 ? 0.75 : 0.45
  let size = Math.round(Math.min(w, areaH) * scale)
  // Row-fit clamp: the whole row (icons + gaps) stays inside the rounded frame.
  const innerW = w - 2 * ICON_ROW_SIDE_INSET
  size = Math.min(size, Math.floor((innerW - (count - 1) * ICON_GAP) / count))
  const rowW = count * size + (count - 1) * ICON_GAP
  const x0 = Math.round((w - rowW) / 2)
  const y = Math.round(areaTop + (areaH - size) / 2)
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (size + ICON_GAP), y, size }))
}
```

In the badge block of `drawIconsTab`, change the font line to:

```ts
    ctx.font = `600 ${Math.max(OVERFLOW_FONT_SIZE, Math.round(slot.size / 2))}px ${DECK_FONT_STACK}`
```

Update the `MAX_ROW_SLOTS` doc comment (its "4 slots overflow an 80px key" claim is now stale): the row-fit clamp guarantees any slot count fits, but 3 remains the visual maximum to mirror TabItem's row — keep `MAX_ROW_SLOTS = 3` and rewrite the comment to say exactly that.

- [ ] **Step 4: Update remaining geometry-derived tests**

Tests deriving from `iconLayout(...)` output (~:150-158 drawImage slot, ~:160-176 avatar circle/font, ~:309-320 repo+agent pairing) adapt automatically IF they compute from `iconLayout` — verify, and where numbers are literal, recompute: 80px single slot 45 → avatar circle r = 22.5 at cx = 18 + 22.5, cy = 28 + 22.5; avatar font `600 25px Inter, sans-serif` (`round(45 * 9/16)`). Update the Task 4 avatar assertion if it hardcoded slot 30.

- [ ] **Step 5: Run the full renderer suite**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): ~50% larger tile icons with row-fit clamp; +N badge scales with its slot"
```

---

### Task 7: Full verification sweep (both consumers, coordinated suites)

The virtual deck panel and the physical deck consume the identical `renderKey`/`renderStrip` (verified: `VirtualDeckPanel.tsx` injects them into `DeckController`; `deck-controller.ts` defaults to the same functions with `defaultCtxFactory`) — so renderer-suite green proves both surfaces render the new look. This task proves nothing else in the ecosystem regressed.

**Files:**
- No production changes expected; fix-ups only if a suite surfaces a miss.

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: green coordinated suites; a clean worktree.

- [ ] **Step 1: Run the deck-adjacent suites**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx`
Expected: PASS (the flow suite stubs renderers with `encodeSpec`, and `deck-controller.test.ts` never touches pixels — they must stay green untouched).

- [ ] **Step 2: Run the VirtualDeckPanel suite**

Run: `npm run test:vitest -- run test/unit/client/components/VirtualDeckPanel.test.tsx`
(If the file lives elsewhere, locate it with `git grep -l "VirtualDeckPanel" test/` and run that path.)
Expected: PASS — the panel's `noopCtx` conforms to the extended `Ctx2D` (Task 1), so rendering degrades silently under jsdom exactly as before.

- [ ] **Step 3: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the coordinated full suite**

Run: `npm run check` (if the repo defines it; otherwise `npm test`) with a generous timeout.
Expected: PASS. Fix any failure caused by this branch before proceeding (unrelated pre-existing failures: note them, do not chase).

- [ ] **Step 5: Confirm the worktree is clean and every commit is focused**

Run: `git status --short && git log --oneline origin/main..HEAD`
Expected: no uncommitted changes; one plan commit plus one commit per task. Do NOT open a PR — that requires explicit user approval.

- [ ] **Step 6: Commit any verification fix-ups**

```bash
git add -A && git commit -m "test(deck): verification sweep fix-ups for deck visual tweaks"
```
(Skip if there is nothing to commit.)

---

## Self-Review Notes (performed at plan time)

- **Spec coverage:** tweak 1 → Task 4; tweak 2 → Task 6; tweak 3 → Task 5; tweak 4 → Tasks 2 + 3; shared-renderer/virtual-deck + suites-green criteria → Task 7; harness/type prerequisites → Task 1. Classic previews touched only by the rounded frame (Tasks 2/3), content pinned — per spec.
- **No silent deferrals:** all four tweaks land as production rendering changes proven by draw-call-level tests (the repo's only renderer-testing mechanism — jsdom deliberately has no canvas, so "corner pixels are black" is proven as *black surround fill + rounded clip installed before any content*, the strongest observable this harness supports). Both consumers share the changed functions; no stubs stand in for shipped behavior.
- **Type consistency:** `keyFrameGeometry`/`KEY_FRAME_RADIUS_RATIO` (Task 2) consumed by Task 3/6; `TEXT_LETTER_SPACING`/`TITLE_SIDE_PADDING` (Task 5) and `ICON_ROW_SIDE_INSET` (Task 6) names used consistently; `drawRing` signature preserved across Task 3; harness fields (`clips`/`strokes`/`measures`, `Text.letterSpacing`) defined in Task 1 and used in Tasks 2–6.
- **Known cross-task test interaction (intentional):** Task 4 writes an avatar-font assertion that Task 6 updates when the slot grows 30 → 45; Task 4 flags this inline so neither implementer is surprised.

## Load-Bearing Validation Notes (post-plan hardening)

Full ledger + evidence reports: `.worktrees/.the-usual-logs/deck-visual-tweaks/load-bearing-ledger.md`.

- **Verified in real headless Chromium 145 (empirical):** `measureText` includes `letterSpacing` after EVERY glyph including the trailing one (10×'M' @5px → exactly +50), matching the Task 1 stub model `t.length * (6 + ls)`; setting `font` after `letterSpacing` neither resets nor ignores the spacing (Task 5's statement order is safe).
- **Falsified → plan changed:** "every real ctx has `roundRect`" is false for Firefox ≤111 / Safari ≤15, and `VirtualDeckPanel`'s `safeCtxFactory` hands a real ctx to the renderer in any browser (README advertises the panel for browsers without WebHID; a throw would propagate uncaught through `DeckController.render`). Fix: Task 1 Step 3 (`ensureRoundRect` guard at both real-ctx seams, square-corner degrade). `ctx.letterSpacing` needs no guard (inert expando pre-support; rendering stays self-consistent).
- **Verified by rendering the real (unmodified) renderer in real Chromium and masking with the planned frame:** clipping the pinned classic preview loses no legible content at any size (72/80px lose 3.5–4.8% of body ink, all right-edge fragments that are ALREADY mid-cut today because `PREVIEW_CHAR_WIDTH = 5.5` understates the true ~6.62px monospace advance — a pre-existing, pinned, out-of-scope quirk the frame tidies). Uniform frame-in-`renderKey` architecture stands; no per-kind opt-out needed. Before/after/diff PNGs in the logs `reports/` dir.
- **Corrections from code inspection:** `drawRing` has 8 call sites (Task 3 said 7 — fixed); `kind: 'empty'` was never rendered in the test file (Task 2's "every kind is already rendered" claim fixed; the frame test introduces the first empty render).
