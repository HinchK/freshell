import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const tileGeo = async (page) => page.evaluate(() => {
  const toolbar = document.querySelector('[data-context="pane-picker"]')!
  const W = toolbar.offsetWidth, H = toolbar.offsetHeight
  const style = getComputedStyle(toolbar)
  const cols = Number(style.getPropertyValue('--cols'))
  const rows = Number(style.getPropertyValue('--rows'))
  const pad = Math.min(28, Math.max(8, 0.03 * W))
  const gap = Math.min(18, Math.max(6, 0.02 * W))
  const raw = Math.min((W - 2 * pad - (cols - 1) * gap) / cols, (H - 2 * pad - (rows - 1) * gap) / rows)
  const expected = Math.max(36, Math.min(120, raw))   // mirrors the production clamp(36px, raw, 120px)
  const tb = toolbar.getBoundingClientRect()
  const tiles = [...toolbar.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect()
    return { w: b.offsetWidth, h: b.offsetHeight, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  })
  return { W, H, cols, rows, expected, tb, tiles }
})

test('pane picker tiles are square, fluid, and fit the pane', async ({ freshellPage: _f, page }) => {
  const assertGeometry = (g) => {
    expect(g.tiles.length).toBeGreaterThan(0)
    for (const t of g.tiles) {
      expect(t.w).toBeGreaterThan(0)
      expect(t.w).toBeCloseTo(t.h, 0)                    // square
      expect(Math.abs(t.w - g.expected)).toBeLessThanOrEqual(1.5) // clamped fluid formula (±1.5, per plan)
      expect(t.left).toBeGreaterThanOrEqual(g.tb.left - 1)
      expect(t.right).toBeLessThanOrEqual(g.tb.right + 1)
      expect(t.top).toBeGreaterThanOrEqual(g.tb.top - 1)
      expect(t.bottom).toBeLessThanOrEqual(g.tb.bottom + 1)
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  const picker = await openPanePicker(page)
  await expect(picker).toBeVisible()
  const first = await tileGeo(page)
  assertGeometry(first)

  await page.setViewportSize({ width: 760, height: 520 })
  // Wait for the ResizeObserver re-render AND for the tiles to reflow to the
  // new container size (the toolbar box resizes on the viewport reflow, but
  // the cq-unit-driven tile size settles a render later), then re-measure.
  await expect.poll(async () => {
    const g = await tileGeo(page)
    const sizeChanged = `${g.W}:${g.H}` !== `${first.W}:${first.H}`
    const tilesSettled = g.tiles.length > 0 && g.tiles.every((t) => Math.abs(t.w - g.expected) < 1)
    return sizeChanged && tilesSettled
  }, { timeout: 10_000 }).toBe(true)
  assertGeometry(await tileGeo(page))
})
