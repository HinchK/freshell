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
    await expect(tabStrip).toHaveClass(/max-h-32/)
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
})
