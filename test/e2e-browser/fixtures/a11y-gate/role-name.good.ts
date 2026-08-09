import { expect, test } from '@playwright/test'
import { ariaNamePattern, byRole } from '../../helpers/accessible-interactions.js'

/**
 * HARNESS-11 gate probe — clean reference. Role/label/keyboard selection
 * only; the a11y selector gate must report ZERO violations when scanning
 * this file. Never executed as a test (it lives outside `specs/`).
 */

test('probe: role and accessible-name selection', async ({ page }) => {
  await byRole(page, 'button', 'New shell tab').click()
  await byRole(page, 'button', ariaNamePattern('Hide sidebar')).click()
  await page.getByLabel('Search sessions').fill('fix')
  await expect(byRole(page, 'tab', ariaNamePattern('Terminal 1'))).toBeVisible()
  await page.keyboard.press('Enter')
})
