import { test, expect } from '../helpers/fixtures.js'

test.describe('Multi-row tabs', () => {
  async function openSettings(page: any) {
    await page.getByRole('button', { name: /settings/i }).click()
    await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 10_000 })
  }

  test('disables multi-row tabs via settings toggle', async ({ freshellPage: page }) => {
    await openSettings(page)
    // The Multi-row tabs toggle lives in the Panes section of the settings view.
    await page.getByRole('tab', { name: /^Panes$/i }).click()

    const toggle = page.getByRole('switch', { name: /multi-row tabs/i })
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
  })

  test('multi-row mode applies flex-wrap to tab strip', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: true } },
      })
    })

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toBeVisible({ timeout: 5_000 })
    await expect(tabStrip).toHaveClass(/flex-wrap/)
    // calc(6.25rem + 1px) computes to 101px at the default --ui-scale of 1.
    await expect(tabStrip).toHaveCSS('max-height', '101px')
  })

  test('single-row mode uses overflow-x-auto', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: false } },
      })
    })

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toBeVisible({ timeout: 5_000 })
    await expect(tabStrip).toHaveClass(/overflow-x-auto/)
    await expect(tabStrip).not.toHaveClass(/flex-wrap/)
  })

  test('multirow tabs render between 150 and 200px wide', async ({ freshellPage: page, harness }) => {
    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)

    const firstTab = page.getByTestId('tab-strip').locator(':scope > div').first()
    await expect(firstTab).toBeVisible()
    const box = await firstTab.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(149)
    expect(box!.width).toBeLessThanOrEqual(201)
  })

  test('single-row tabs are fixed at 175px', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: false } },
      })
    })

    const firstTab = page.getByTestId('tab-strip').locator(':scope > div').first()
    await expect(firstTab).toBeVisible()
    const box = await firstTab.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.round(box!.width)).toBe(175)
  })

  test('last-row tabs match the width of the full rows above', async ({ freshellPage: page, harness }) => {
    // 11 tabs at a >=150px basis is >1650px of tabs — guaranteed to wrap to 2+
    // rows at the default 1280px viewport, with a strict partial last row
    // (11 is prime, so it never divides evenly into full rows).
    for (let i = 0; i < 10; i++) {
      await page.locator('[data-context="tab-add"]').click()
    }
    await harness.waitForTabCount(11)

    const wrappers = page.getByTestId('tab-strip').locator(':scope > div')
    await expect(wrappers).toHaveCount(11)

    const boxes: { x: number; y: number; width: number; height: number }[] = []
    for (let i = 0; i < 11; i++) {
      const box = await wrappers.nth(i).boundingBox()
      expect(box).not.toBeNull()
      boxes.push(box!)
    }

    // Recover rows from geometry: tabs on the same wrapped row share a y.
    const rowYs = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((a, b) => a - b)
    expect(rowYs.length).toBeGreaterThanOrEqual(2) // the scenario really wraps

    const tabsPerRow = rowYs.map((y) => boxes.filter((b) => Math.round(b.y) === y).length)
    const lastRowCount = tabsPerRow[tabsPerRow.length - 1]
    // The bug's trigger condition: the bottom row is a strict partial row.
    expect(lastRowCount).toBeLessThan(tabsPerRow[0])

    // THE invariant: every tab — full rows AND the partial last row — renders
    // at the same width (1px tolerance for sub-pixel rounding; calibrated for
    // Chromium, the only engine that gates this spec today).
    const widths = boxes.map((b) => b.width)
    const minWidth = Math.min(...widths)
    const maxWidth = Math.max(...widths)
    expect(maxWidth - minWidth).toBeLessThanOrEqual(1)

    // The locked width still respects the multirow 150-200px bounds.
    expect(minWidth).toBeGreaterThanOrEqual(149)
    expect(maxWidth).toBeLessThanOrEqual(201)

    // And the partial last row ends short of the strip's right edge (it is
    // missing at least one >=150px tab relative to the full rows).
    const stripBox = await page.getByTestId('tab-strip').boundingBox()
    expect(stripBox).not.toBeNull()
    const lastRowY = rowYs[rowYs.length - 1]
    const lastRowRight = Math.max(
      ...boxes.filter((b) => Math.round(b.y) === lastRowY).map((b) => b.x + b.width),
    )
    expect(lastRowRight).toBeLessThan(stripBox!.x + stripBox!.width - 100)
  })
})
