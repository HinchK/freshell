import { test, expect } from '../helpers/fixtures.js'
import type { Page, Locator } from '@playwright/test'

const rootFontSize = (page: Page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))

const headerZoneHeight = async (page: Page, header: Locator) => {
  const box = (await header.boundingBox())!
  const borderH = await header.evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth))
  return box.height - borderH
}

const closeWithin = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

const expectSquareZone = (box: { width: number; height: number }, zoneHeight: number) => {
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(box.height - zoneHeight)).toBeLessThanOrEqual(0.5)
}

const expectTouching = (boxes: { x: number; width: number }[]) => {
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width))).toBeLessThanOrEqual(0.1)
  }
}

const expectSquareTouchingZones = async (header: Locator, zoneH: number) => {
  const buttons = await header.getByRole('button').all()
  expect(buttons.length).toBeGreaterThanOrEqual(2)
  const boxes: { x: number; width: number; height: number }[] = []
  for (const b of buttons) boxes.push((await b.boundingBox())!)
  boxes.sort((a, b) => a.x - b.x)
  for (const box of boxes) expectSquareZone(box, zoneH)
  expectTouching(boxes)
}

const HIT_ZONES_SESSION_ID = '73333000-0000-4333-8333-000000000003'

async function createTerminalPane(page: Page) {
  await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function createFreshAgentPane(page: Page) {
  await createTerminalPane(page)
  await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${HIT_ZONES_SESSION_ID}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshclaude',
        provider: 'claude',
        threadId: HIT_ZONES_SESSION_ID,
        sessionId: HIT_ZONES_SESSION_ID,
        revision: 1,
        latestTurnId: null,
        status: 'idle',
        capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
        settings: { model: 'claude-opus-4-6', permissionMode: 'default', plugins: [] },
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        turns: [],
        extensions: {
          claude: {
            liveSessionId: HIT_ZONES_SESSION_ID,
            cliSessionId: HIT_ZONES_SESSION_ID,
          },
        },
      }),
    })
  })
  await page.evaluate((sessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (!tabId || !paneId) throw new Error('expected an active boot pane to convert into a fresh-agent pane')
    harness?.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness?.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-pane-header-hit-zones',
          sessionId,
          sessionRef: { provider: 'claude', sessionId },
          resumeSessionId: sessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, HIT_ZONES_SESSION_ID)
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 10_000 })
}

async function splitFreshAgentPaneThreeTimes(page: Page) {
  const { tabId, paneId } = await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const layout = activeTabId ? state?.panes?.layouts?.[activeTabId] : null
    return { tabId: activeTabId, paneId: layout?.type === 'leaf' ? layout.id : null }
  })
  if (!tabId || !paneId) throw new Error('expected a single fresh-agent pane leaf before splitting')
  let targetPaneId = paneId
  for (let splitIndex = 0; splitIndex < 3; splitIndex++) {
    const newPaneId = `pane-header-hit-zones-split-${splitIndex}`
    const sessionId = `pane-header-hit-zones-split-session-${splitIndex}`
    await page.evaluate(({ currentTabId, currentPaneId, nextPaneId, nextSessionId }) => {
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(nextPaneId, true)
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          direction: 'horizontal',
          newPaneId: nextPaneId,
          newContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: `req-${nextPaneId}`,
            sessionId: nextSessionId,
            resumeSessionId: nextSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentPaneId: targetPaneId, nextPaneId: newPaneId, nextSessionId: sessionId })
    await expect(page.locator(`[data-context="pane"][data-pane-id="${newPaneId}"]`)).toBeVisible({ timeout: 10_000 })
    targetPaneId = newPaneId
  }
  await page.waitForTimeout(300)
}

test.describe('desktop pane header hit zones (>= 640px viewport)', () => {
  test('zones are full-height squares that touch; visuals unchanged', async ({ freshellPage, page }) => {
    await createTerminalPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const headerBox = (await header.boundingBox())!
    closeWithin(headerBox.height, 1.75 * root)
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 1.75 * root - 1)

    await expectSquareTouchingZones(header, zoneH)
    const closeSvg = header.getByTitle('Close pane').locator('svg')
    closeWithin((await closeSvg.boundingBox())!.width, 0.75 * root)
    const paneIcon = header.locator('svg').first()
    closeWithin((await paneIcon.boundingBox())!.width, 0.875 * root)
  })

  test('fresh-agent gear zone is a full-height square at normal width', async ({ freshellPage, page }) => {
    await createFreshAgentPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 1.75 * root - 1)
    const gear = header.getByTitle('Agent settings')
    expectSquareZone((await gear.boundingBox())!, zoneH)
  })

  test('ultra-narrow fresh-agent panes hide optional actions and keep square full-height zones', async ({ freshellPage, page }) => {
    await createFreshAgentPane(page)
    await splitFreshAgentPaneThreeTimes(page)
    const header = page.getByRole('banner', { name: /Pane:/ }).last()
    await expect(header).toBeVisible()
    await expect(header.getByTitle('Agent settings')).toBeHidden()
    await expect(header.getByTitle('Maximize pane')).toBeHidden()
    const zoneH = await headerZoneHeight(page, header)
    const close = header.getByTitle('Close pane')
    expectSquareZone((await close.boundingBox())!, zoneH)
  })
})

test.describe('mobile pane header hit zones (390px viewport)', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('size increase is mobile-only; zones are full-height squares that touch', async ({ freshellPage, page }) => {
    await createTerminalPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const headerBox = (await header.boundingBox())!
    closeWithin(headerBox.height, 2.75 * root)
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 2.75 * root - 1)

    await expectSquareTouchingZones(header, zoneH)
    const close = header.getByTitle('Close pane')
    const closeSvg = close.locator('svg')
    closeWithin((await closeSvg.boundingBox())!.width, 1.25 * root)
    const paneIcon = header.locator('svg').first()
    closeWithin((await paneIcon.boundingBox())!.width, 1 * root)
  })
})
