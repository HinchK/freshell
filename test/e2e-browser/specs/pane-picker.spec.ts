import { test, expect } from '../helpers/fixtures.js'
import { clickFirstVisibleShellOption, openPanePicker } from '../helpers/pane-picker.js'

test.describe('Pane picker', () => {
  test('shows base pane types', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const picker = await openPanePicker(page)

    await expect(picker.getByRole('button', { name: /^Editor$/i })).toBeVisible()
    await expect(picker.getByRole('button', { name: /^Browser$/i })).toBeVisible()

    const shellVisible = await picker.getByRole('button', { name: /^Shell$/i }).isVisible().catch(() => false)
    const wslVisible = await picker.getByRole('button', { name: /^WSL$/i }).isVisible().catch(() => false)
    const cmdVisible = await picker.getByRole('button', { name: /^CMD$/i }).isVisible().catch(() => false)
    const psVisible = await picker.getByRole('button', { name: /^PowerShell$/i }).isVisible().catch(() => false)
    expect(shellVisible || wslVisible || cmdVisible || psVisible).toBe(true)
  })

  test('creates a shell pane when a shell option is selected', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await openPanePicker(page)

    await clickFirstVisibleShellOption(page)
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    const activeTabId = await harness.getActiveTabId()
    expect(activeTabId).toBeTruthy()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.children).toHaveLength(2)

    await page.locator('button[title="Close pane"]').last().click()
    await expect.poll(async () => {
      const nextLayout = await harness.getPaneLayout(activeTabId!)
      return nextLayout?.type
    }).toBe('leaf')
  })

  test('openPanePicker uses the add-pane-button fallback when no terminal is visible', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Swap the terminal pane for an editor pane so no .xterm is visible and
    // openPanePicker must take its add-pane-button fallback branch (the FAB
    // is opt-in; the adapted helper enables it through the test harness).
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string
    await page.evaluate(({ currentTabId, currentPaneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
            wordWrap: true,
          },
        },
      })
    }, { currentTabId: tabId!, currentPaneId: paneId })
    await expect(page.locator('.xterm')).toHaveCount(0, { timeout: 10_000 })

    const picker = await openPanePicker(page)
    await expect(picker.getByRole('button', { name: /^Editor$/i })).toBeVisible()
  })
})
