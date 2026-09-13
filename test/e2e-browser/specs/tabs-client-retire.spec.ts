import type { Browser, Page } from '@playwright/test'
import {
  createE2eBrowserContext,
  type E2eMachine,
  registerE2eMachine,
  test,
  expect,
} from '../helpers/fixtures.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'

const RETIRED_TAB_TITLE = 'Retire endpoint e2e tab'
const RETIRED_DEVICE_LABEL = 'closing-device-e2e'

interface DevicePage {
  page: Page
  machine: E2eMachine
}

async function newDevicePage(
  browser: Browser,
  serverInfo: E2eServerInfo,
  deviceLabel: string,
): Promise<DevicePage> {
  const machine = await registerE2eMachine(serverInfo, deviceLabel)
  const context = await createE2eBrowserContext(browser, serverInfo, machine.id)
  installRecoveryOfferAutoDeclineOnContext(context)
  const page = await context.newPage()
  await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
  await waitForReady(page)
  return { page, machine }
}

async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    return harness?.getWsReadyState() === 'ready'
      && harness.getState()?.connection?.status === 'ready'
  }, { timeout: 15_000 })
}

async function waitForTabsSnapshot(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    return !!state?.tabRegistry?.lastSnapshotAt && state.tabRegistry.loading === false
  }, { timeout: 15_000 })
}

async function openTabsView(page: Page): Promise<void> {
  await page.getByTitle(/^Tabs \(Ctrl\+B A\)$/).click()
  await expect(page.getByRole('heading', { name: 'Tabs' })).toBeVisible()
}

async function seedBrowserTab(page: Page, title: string): Promise<void> {
  await page.evaluate((tabTitle) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')

    harness.clearSentWsMessages?.()
    harness.dispatch({
      type: 'tabs/addTab',
      payload: {
        id: 'retire-e2e-tab',
        title: tabTitle,
        mode: 'shell',
        status: 'running',
        titleSetByUser: true,
      },
    })
    harness.dispatch({
      type: 'panes/initLayout',
      payload: {
        tabId: 'retire-e2e-tab',
        paneId: 'retire-e2e-pane',
        content: {
          kind: 'browser',
          url: 'https://example.com/retire-e2e',
        },
      },
    })
  }, title)

  await page.waitForFunction((tabTitle) => {
    const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
    return sent.some((message: any) =>
      message?.type === 'tabs.sync.push'
      && Array.isArray(message.records)
      && message.records.some((record: any) => record.tabName === tabTitle && record.status === 'open')
    )
  }, title, { timeout: 15_000 })
}

async function retireByPagehideWithoutWebSocket(page: Page, machineId: string): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')
    harness.forceDisconnect()
  })
  await page.waitForFunction(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
    return state !== 'ready'
  }, { timeout: 5_000 })
  const receipt = page.waitForResponse((response) => {
    const request = response.request()
    return request.method() === 'POST'
      && new URL(response.url()).pathname === '/api/tabs-sync/client-retire'
  })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'))
  })
  const response = await receipt
  expect(response.status()).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true, accepted: true })
  const body = response.request().postDataJSON() as {
    deviceId?: unknown
    clientInstanceId?: unknown
    snapshotRevision?: unknown
  }
  expect(body.deviceId).toBe(machineId)
  expect(typeof body.clientInstanceId).toBe('string')
  expect((body.clientInstanceId as string).length).toBeGreaterThan(0)
  expect(typeof body.snapshotRevision).toBe('number')
  expect(body.snapshotRevision).toBeGreaterThanOrEqual(0)
  await page.close()
}

test('closed browser client is removed from the Tabs UI through the unload retire API', async ({ browser, serverInfo }) => {
  const closing = await newDevicePage(browser, serverInfo, RETIRED_DEVICE_LABEL)
  await seedBrowserTab(closing.page, RETIRED_TAB_TITLE)

  const before = await newDevicePage(browser, serverInfo, 'observer-before-e2e')
  await waitForTabsSnapshot(before.page)
  await openTabsView(before.page)
  await expect(before.page.getByRole('button', {
    name: `${RETIRED_DEVICE_LABEL}: ${RETIRED_TAB_TITLE}`,
  })).toBeVisible()
  await before.page.context().close()

  await retireByPagehideWithoutWebSocket(closing.page, closing.machine.id)

  const after = await newDevicePage(browser, serverInfo, 'observer-after-e2e')
  await waitForTabsSnapshot(after.page)
  await openTabsView(after.page)
  await expect(after.page.getByRole('button', {
    name: `${RETIRED_DEVICE_LABEL}: ${RETIRED_TAB_TITLE}`,
  })).toHaveCount(0)

  await after.page.context().close()
})
