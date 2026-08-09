import { test } from '@playwright/test'

/**
 * HARNESS-11 gate probe — DELIBERATE violations.
 *
 * This file is a scan target for the a11y selector gate's bite demonstration
 * (`a11y-selector-gate.test.ts` and the self-test's leg C). It is never
 * executed as a test (it lives outside `specs/`) and `fixtures/` is excluded
 * from the gate's normal tree scan. Each `locator` call below relies on a
 * CSS-implementation detail and must be flagged with the expected code:
 *
 *   1. `.fresh-agent-layout > .fresh-agent-transcript` -> structural-combinator
 *   2. `.pane-header-fresh-agent-identity`             -> css-class
 *   3. `xpath=//div[@class="tabbar"]/button[3]`        -> xpath
 *   4. `..`                                            -> parent-traversal
 *   5. `li:nth-child(2)`                               -> structural-pseudo
 *   6. `div.h-3.w-3[data-selected="true"]`             -> css-class
 */

test('probe: css-implementation-dependent selectors', async ({ page }) => {
  await page.locator('.fresh-agent-layout > .fresh-agent-transcript').waitFor()
  await page.locator('.pane-header-fresh-agent-identity').click()
  await page.locator('xpath=//div[@class="tabbar"]/button[3]').click()
  await page.locator('..').first().hover()
  await page.locator('li:nth-child(2)').click()
  await page.locator('div.h-3.w-3[data-selected="true"]').click()
})
