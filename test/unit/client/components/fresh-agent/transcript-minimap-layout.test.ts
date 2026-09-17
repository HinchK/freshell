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
    // allowed). Proportional spacing exactly equals the thinned height
    // (2/3px each), so every tick keeps its exact proportional top — 30
    // distinct ticks, monotonic, in-bounds. No two ticks share coordinates:
    // nothing occludes anything.
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

  it('scales the final colliding group to fit the rail, anchored at its proportional start', () => {
    // Two huge prompts: proportional heights 60px each cannot fit a 100px
    // rail (the second would clamp back onto the first), so they form one
    // group anchored at the first proportional top (0) whose heights scale
    // by 100/120 -> 50 each, tops 0 / 50 — distinct, in-bounds, and the
    // anchor keeps the group's proportional start.
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

  it('keeps a locally dense cluster near its proportional position — no reset to the rail top', () => {
    // One early prompt, then five short prompts bunched after a long
    // response (offsets 9500..9900 of a 10000px transcript on a 200px
    // rail): proportional tops 190/192/194/196/198 collide at the 3px
    // minimum (effectiveMin = min(3, 200/6) = 3), forming one final group
    // anchored at 190. It scales to end at the rail bottom — the five late
    // prompts stay near the BOTTOM, near their proportional positions,
    // never packed from the rail top.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 200,
      landmarks: [
        landmark(0, 0),
        landmark(1, 9500), landmark(2, 9600), landmark(3, 9700),
        landmark(4, 9800), landmark(5, 9900),
      ],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[0].height).toBeCloseTo(3, 5)
    expect(layout.ticks[1].top).toBeCloseTo(190, 5)
    expect(layout.ticks[2].top).toBeCloseTo(192, 5)
    expect(layout.ticks[3].top).toBeCloseTo(194, 5)
    expect(layout.ticks[4].top).toBeCloseTo(196, 5)
    expect(layout.ticks[5].top).toBeCloseTo(198, 5)
    // Heights thinned 3 -> 2 (scale 10/15) so the group ends at the rail bottom.
    expect(layout.ticks[1].height).toBeCloseTo(2, 5)
    expect(layout.ticks[5].top + layout.ticks[5].height).toBeCloseTo(200, 5)
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
