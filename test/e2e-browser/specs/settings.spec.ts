import { test, expect } from '../helpers/fixtures.js'
import { isCloudLaneWindowConfigured } from '../helpers/test-harness.js'

// The browser-preferences persist path debounces localStorage writes by
// 500ms; wait past it before reading the blob.
const PERSIST_DEBOUNCE_WAIT_MS = 600

test.describe('Settings', () => {
  // Helper: navigate to the settings view.
  // Sidebar nav buttons have title="Settings (Ctrl+B ,)" which Playwright
  // matches via getByRole with name /settings/i (title is used as accessible name).
  async function openSettings(page: any) {
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await settingsButton.click()
    await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 5_000 })
  }

  async function openSettingsSection(page: any, section: string) {
    await openSettings(page)
    await page.getByRole('tab', { name: new RegExp(`^${section}$`, 'i') }).click()
    const panelName = section.toLowerCase().replace(/ /g, '-')
    await expect(page.getByRole('tabpanel', { name: new RegExp(`${panelName} settings`, 'i') })).toBeVisible({
      timeout: 5_000,
    })
  }

  test('settings view is accessible from sidebar', async ({ freshellPage, page }) => {
    await openSettings(page)

    await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Coding Agents$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Panes$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Workspace$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Naming$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Network$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Advanced$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^AI$/i })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^Safety$/i })).toHaveCount(0)
  })

  test('terminal font size input changes setting', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // The Font size row renders a SteppedRangeInput: an index-based slider plus
    // a numeric input. The slider's value is a stop *index*, not px, so drive
    // the setting through the px-valued spinbutton instead.
    const fontSizeInput = page.getByRole('spinbutton', { name: 'Font size' })
    await expect(fontSizeInput).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const fontSizeBefore = settingsBefore.terminal.fontSize

    await fontSizeInput.fill('20')
    await fontSizeInput.press('Enter')
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.terminal.fontSize).toBe(20)
    expect(settingsAfter.terminal.fontSize).not.toBe(fontSizeBefore)

    // The slider announces the px value with its percent annotation.
    const fontSizeSlider = page.getByRole('slider', { name: 'Font size' })
    await expect(fontSizeSlider).toHaveAttribute('aria-valuetext', '20px (125%)')
  })

  test('terminal color scheme selection', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // SettingsRow label="Color scheme" contains a <select> element.
    // Find the Color scheme row, then the select within it.
    const colorSchemeRow = page.getByText('Color scheme')
    await expect(colorSchemeRow).toBeVisible()

    const colorSelect = colorSchemeRow.locator('..').locator('select')
    await expect(colorSelect).toBeVisible()

    // Change to "dracula" theme
    await colorSelect.selectOption('dracula')
    await page.waitForTimeout(500)

    const settings = await harness.getSettings()
    expect(settings.terminal.theme).toBe('dracula')
  })

  test('settings persist after reload', async ({ freshellPage, page, harness, serverInfo }) => {
    // This test reloads mid-body and re-waits for the connection. The
    // cloud-gated declaration is EXACTLY the removed settings hook's
    // coverage restored, scoped to the one test that needs it (delta
    // reviews r9+r10): under the cloud window the wait's legal envelope
    // (W+1s = 91s at W=90s) exceeds the config's 60s body default, and the
    // hook this file used to carry (kata tg4e Task 5 removed it) gave this
    // body 120s. Locally the env is unset: no declaration, and the 60s
    // default is the exact pre-run local behavior.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)
    await openSettings(page)

    // Change a setting: toggle cursor blink
    const cursorBlinkRow = page.getByText('Cursor blink')
    await expect(cursorBlinkRow).toBeVisible()

    // Toggle uses role="switch" within the row
    const toggle = cursorBlinkRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const blinkBefore = settingsBefore.terminal.cursorBlink

    await toggle.click()
    await page.waitForTimeout(500)

    // Verify changed
    const settingsAfterToggle = await harness.getSettings()
    expect(settingsAfterToggle.terminal.cursorBlink).toBe(!blinkBefore)

    // Reload the page
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Settings should be loaded from server and persist
    const settingsAfterReload = await harness.getSettings()
    expect(settingsAfterReload.terminal.cursorBlink).toBe(!blinkBefore)
  })

  test('cursor blink toggle works', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // Find "Cursor blink" row, then its Toggle (role="switch")
    const cursorBlinkRow = page.getByText('Cursor blink')
    await expect(cursorBlinkRow).toBeVisible()

    const toggle = cursorBlinkRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const blinkBefore = settingsBefore.terminal.cursorBlink

    await toggle.click()
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.terminal.cursorBlink).toBe(!blinkBefore)
  })

  test('scrollback lines slider changes setting', async ({ freshellPage, page, harness }) => {
    await openSettingsSection(page, 'Advanced')

    // "Scrollback lines" row with RangeSlider
    const scrollbackRow = page.getByText('Scrollback lines')
    await expect(scrollbackRow).toBeVisible()

    const scrollbackSlider = scrollbackRow.locator('..').locator('input[type="range"]')
    await expect(scrollbackSlider).toBeVisible()

    await scrollbackSlider.fill('5000')
    await scrollbackSlider.dispatchEvent('pointerup')
    await page.waitForTimeout(500)

    const settings = await harness.getSettings()
    expect(settings.terminal.scrollback).toBe(5000)
  })

  test('debug logging toggle', async ({ freshellPage, page, harness }) => {
    await openSettingsSection(page, 'Advanced')

    // Advanced section contains the debug logging row.
    const debugLoggingRow = page.getByText('Debug logging')
    await expect(debugLoggingRow).toBeVisible()

    // Toggle within the row (role="switch")
    const toggle = debugLoggingRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const debugBefore = settingsBefore.logging?.debug ?? false

    await toggle.click()
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.logging?.debug).toBe(!debugBefore)
  })

  test('appearance section has theme controls', async ({ freshellPage, page }) => {
    await openSettings(page)

    // The Appearance section has theme controls (SegmentedControl for system/light/dark)
    await expect(page.getByText('Appearance').first()).toBeVisible()
    // Verify at least one theme mode button is present
    await expect(
      page.getByRole('button', { name: /system|light|dark/i }).first()
    ).toBeVisible()
  })

  test('Expand thinking and Expand tools switches persist locally and reset to defaults', async ({ freshellPage, page, harness, serverInfo }) => {
    // Reloads mid-body with the self-healing connection wait (opted in on
    // the cloud lane). The cloud-gated declaration is EXACTLY the removed
    // settings hook's coverage restored, scoped to the one test that needs
    // it (delta reviews r9+r10): the wait's legal envelope (W+1s = 91s at
    // W=90s) exceeds the config's 60s body default, and the hook gave this
    // body 120s. Locally: no declaration, the exact pre-run 60s behavior.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)
    await openSettingsSection(page, 'Coding Agents')

    // Accessible-name switch locators (each Toggle carries an exact aria-label
    // matching its row label).
    const expandThinkingSwitch = page.getByRole('switch', { name: 'Expand thinking' })
    const expandToolsSwitch = page.getByRole('switch', { name: 'Expand tools' })
    // Compact defaults: both switches start off.
    await expect(expandThinkingSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(expandToolsSwitch).toHaveAttribute('aria-checked', 'false')

    // Opt in to both expansion defaults.
    await expandThinkingSwitch.click()
    await expandToolsSwitch.click()
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const settings = await harness.getSettings()
    expect(settings.freshAgent.expandThinking).toBe(true)
    expect(settings.freshAgent.expandTools).toBe(true)
    // The blob holds ONLY non-default values (diff-vs-defaults).
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    const parsed = JSON.parse(blob ?? '{}')
    expect(parsed.settings?.freshAgent?.expandThinking).toBe(true)
    expect(parsed.settings?.freshAgent?.expandTools).toBe(true)

    // The opt-in persists across reload. Self-heal is safe (and opted in,
    // cloud lane only — one presence rule shared with the budget resolver,
    // kata tg4e) on this fresh-boot leg: the state under test lives in
    // localStorage, which survives a reload by design. Locally the wait
    // keeps its exact historical single-shot semantics.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    const afterReload = (await harness.getSettings()).freshAgent
    expect(afterReload.expandThinking).toBe(true)
    expect(afterReload.expandTools).toBe(true)
    const blobReload = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    const parsedReload = JSON.parse(blobReload ?? '{}')
    expect(parsedReload.settings?.freshAgent?.expandThinking).toBe(true)
    expect(parsedReload.settings?.freshAgent?.expandTools).toBe(true)

    // Resetting both to defaults drops the keys from the blob (diff-vs-defaults).
    await openSettingsSection(page, 'Coding Agents')
    await expandThinkingSwitch.click()
    await expandToolsSwitch.click()
    await expect(expandThinkingSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(expandToolsSwitch).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const blobOff = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blobOff ?? '{}').settings?.freshAgent).toBeUndefined()
  })

  test('floating add-pane button is hidden by default, can be enabled, and persists locally', async ({ freshellPage, page, harness, serverInfo }) => {
    // Two reload legs plus two settings sessions; the cloud-gated budget
    // follows the Expand thinking reload-leg precedent in this file.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)

    // The FAB is opt-in: a default boot never renders it.
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)

    await openSettingsSection(page, 'Panes')
    const fabSwitch = page.getByRole('switch', { name: 'Toggle floating add-pane button' })
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'false')

    // Opt in; the resolved setting and the persisted blob (diff-vs-defaults)
    // both carry the key.
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(true)
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blob ?? '{}').settings?.panes?.floatingActionButton).toBe(true)

    // The opt-in persists across reload and the FAB is visible on the next
    // boot (tabs/panes restore from localStorage; the 10s timeout rides
    // out the restore).
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(true)
    await expect(page.getByRole('button', { name: 'Add pane' })).toBeVisible({ timeout: 10_000 })

    // Resetting to the default drops the key from the blob, and the next
    // boot renders without the FAB again.
    await openSettingsSection(page, 'Panes')
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const blobOff = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blobOff ?? '{}').settings?.panes?.floatingActionButton).toBeUndefined()

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)
  })
})
