import { describe, expect, it } from 'vitest'
import {
  computeMinimapLayout,
  MINIMAP_MIN_TICK_HEIGHT_PX,
  MINIMAP_TICK_MIN_CLICKABLE_PX,
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

  it('breaks offsetTop ties by landmark index (reversed input order)', () => {
    // Equal offsetTops: without the index tie-break, modern V8's STABLE sort
    // keeps the tied pair in INPUT order (2 before 1) and the output would be
    // [0, 2, 1] — the pre-existing test only exercises distinct offsetTops,
    // so the tie comparator was never behaviorally pinned.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(2, 500), landmark(1, 500), landmark(0, 0)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2])
    // The tied pair collides proportionally (both tops 25 at scale 0.05) and
    // packs by abut: index 1 anchors at 25, index 2 abuts at 30.
    expect(layout.ticks[1].top).toBeCloseTo(25, 5)
    expect(layout.ticks[2].top).toBeCloseTo(30, 5)
  })

  it('exposes clickability clusters with span and membership (3-colliding case)', () => {
    // The 3-colliding case: laid-out tops 0/3/6 at 3px heights. The
    // clickability pass (a second pass over the FINAL ticks, not the
    // packing loop's groups) joins each next tick that begins within its
    // predecessor's 4px click row — 3 < 0+4 and 6 < 3+4 — forming ONE run
    // spanning rail 0..9; every member is under the 4px clickable floor,
    // so the cluster is dense.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 9, startIndex: 0, endIndex: 2, dense: true },
    ])
  })

  it('keeps individually-clickable packed ticks as separate non-dense runs', () => {
    // Two huge prompts scale to 50px ticks (final-group scaling 60 -> 50)
    // packed at tops 0/50. They collide for PACKING purposes, but the
    // clickability pass does not join them (50 >= 0+4): two singleton runs,
    // each comfortably clickable — no open-list affordance. This is the
    // case the packing-group cluster design wrongly merged.
    const layout = computeMinimapLayout({
      scrollHeight: 500, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 300), landmark(1, 250, 300)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 50, startIndex: 0, endIndex: 0, dense: false },
      { top: 50, height: 50, startIndex: 1, endIndex: 1, dense: false },
    ])
  })

  it('treats the clickable floor as inclusive — 4px ticks stay directly clickable', () => {
    // scale 0.04: 100px turns land exactly at the 4px floor. Both ticks
    // are exactly 4px and abut at tops 0/4 — the clickability pass does
    // not join them (4 < prevTop+4 is false) and each singleton run is
    // dense: false (dense is strictly-below the floor). A 75px turn (3px)
    // in the same geometry stays separate too, but its singleton run is
    // dense: a lone sub-4px tick.
    const atFloor = computeMinimapLayout({
      scrollHeight: 2500, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 100)],
    })
    expect(atFloor.ticks[0].height).toBeCloseTo(MINIMAP_TICK_MIN_CLICKABLE_PX, 5)
    expect(atFloor.clusters).toEqual([
      { top: 0, height: 4, startIndex: 0, endIndex: 0, dense: false },
      { top: 4, height: 4, startIndex: 1, endIndex: 1, dense: false },
    ])

    const belowFloor = computeMinimapLayout({
      scrollHeight: 2500, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 75)],
    })
    expect(belowFloor.clusters[1].dense).toBe(true)
  })

  it('reports singleton clusters for non-colliding ticks (never dense) and none for degenerate inputs', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(2, 1000), landmark(4, 1900)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 5, startIndex: 0, endIndex: 0, dense: false },
      { top: 50, height: 5, startIndex: 1, endIndex: 1, dense: false },
      { top: 95, height: 5, startIndex: 2, endIndex: 2, dense: false },
    ])

    const degenerate = computeMinimapLayout({
      scrollHeight: 0, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0)],
    })
    expect(degenerate.clusters).toEqual([])
  })

  it('collapses absurd density into ONE dense run — 30 sub-pixel ticks, every join satisfied', () => {
    // rail 20, scrollHeight 3000, 30 landmarks at i*100: 30 ticks at 2/3px
    // pitch and 2/3px height (the packer keeps every proportional top —
    // see the pre-existing absurd-density tick test). The clickability
    // pass joins EVERY consecutive pair (2/3 < prevTop+4), so the whole
    // rail is ONE run, startIndex 0..endIndex 29, dense (every member is
    // sub-4px). This is the extreme-density case the packing-group
    // cluster design missed.
    const layout = computeMinimapLayout({
      scrollHeight: 3000, viewportHeight: 400, scrollTop: 0, railHeight: 20,
      landmarks: Array.from({ length: 30 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.clusters).toHaveLength(1)
    expect(layout.clusters[0].startIndex).toBe(0)
    expect(layout.clusters[0].endIndex).toBe(29)
    expect(layout.clusters[0].dense).toBe(true)
    expect(layout.clusters[0].top).toBeCloseTo(0, 5)
    expect(layout.clusters[0].height).toBeCloseTo(20, 5)
  })

  it('keeps evenly-dense isolated ticks as dense singletons — every lone sub-4px tick is its own run', () => {
    // rail 200, scrollHeight 10000, 50 landmarks at i*200 with 150px rects:
    // scale 0.02, proportional heights 150*0.02 = 3, effectiveMin
    // min(3, 200/50) = 3, tops at 4px pitch (i*4). The clickability pass
    // joins NOTHING (4 < prevTop+4 is false) — 50 singleton clusters, each
    // dense (membership 1, sub-4px member): lone sub-4px ticks, the
    // geometry the component's expanded-hit treatment is built for.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 200,
      landmarks: Array.from({ length: 50 }, (_, i) => landmark(i, i * 200, 150)),
    })
    expect(layout.clusters).toHaveLength(50)
    layout.clusters.forEach((cluster, i) => {
      expect(cluster.startIndex).toBe(i)
      expect(cluster.endIndex).toBe(i)
      expect(cluster.top).toBeCloseTo(i * 4, 5)
      expect(cluster.height).toBeCloseTo(3, 5)
      expect(cluster.dense).toBe(true)
    })
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
