import {
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test'
import { type E2eServerInfo } from './server-fixture-support.js'
import { TestHarness } from './test-harness.js'
import { TerminalHelper } from './terminal-helpers.js'
import { createE2eServerHandle, type E2eServerHandle } from './external-target.js'
import {
  installRecoveryOfferAutoDeclineOnContext,
  type RecoveryOfferHandling,
} from './recovery-offer.js'
import {
  MACHINE_ID_STORAGE_KEY,
  STORAGE_VERSION,
  STORAGE_VERSION_KEY,
} from '../../../src/store/storage-keys.js'

type MachineIdentityHandling = 'auto-select' | 'manual'

export interface E2eMachine {
  id: string
  label: string
}

/** Register a machine the Rust server will accept before an isolated context boots. */
export async function registerE2eMachine(
  serverInfo: E2eServerInfo,
  label = `Playwright test machine ${Date.now()}`,
): Promise<E2eMachine> {
  const headers = { 'x-auth-token': serverInfo.token }
  const created = await fetch(`${serverInfo.baseUrl}/api/machines`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!created.ok) {
    throw new Error(`Could not create E2E machine: HTTP ${created.status}`)
  }
  const createBody = await created.json() as { machine?: { id?: unknown; label?: unknown } }
  const machine = createBody.machine
  if (
    typeof machine?.id !== 'string' || machine.id.length === 0
    || typeof machine.label !== 'string' || machine.label.length === 0
  ) {
    throw new Error('E2E machine response did not contain an id and label')
  }
  return { id: machine.id, label: machine.label }
}

/**
 * Install the machine selection before a context's first navigation. This is
 * shared by the built-in fixture and spec-owned contexts, which otherwise
 * stop at the Rust server's machine chooser as soon as a machine exists.
 */
export async function installE2eMachineIdentity(
  context: BrowserContext,
  serverInfo: E2eServerInfo,
  machineId: string,
): Promise<void> {
  await context.addInitScript(({ machineKey, machineId, serverOrigin, versionKey, version }) => {
    if (window.location.origin !== serverOrigin) return
    localStorage.setItem(versionKey, String(version))
    localStorage.setItem(machineKey, machineId)
  }, {
    machineKey: MACHINE_ID_STORAGE_KEY,
    machineId,
    serverOrigin: new URL(serverInfo.baseUrl).origin,
    versionKey: STORAGE_VERSION_KEY,
    version: STORAGE_VERSION,
  })
}

/** Create an isolated browser context that selects an already registered machine. */
export async function createE2eBrowserContext(
  browser: Browser,
  serverInfo: E2eServerInfo,
  machineId: string,
  options?: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options)
  await installE2eMachineIdentity(context, serverInfo, machineId)
  return context
}

/** Create an isolated context with its own registered machine before it navigates. */
export async function createFreshE2eBrowserContext(
  browser: Browser,
  serverInfo: E2eServerInfo,
  options?: BrowserContextOptions,
): Promise<{ context: BrowserContext; machine: E2eMachine }> {
  const machine = await registerE2eMachine(serverInfo)
  const context = await createE2eBrowserContext(browser, serverInfo, machine.id, options)
  return { context, machine }
}

/**
 * Select a shell from the PanePicker, handling the race condition where
 * buttons can be detached during the platform-info Redux update.
 *
 * Strategy: Use Playwright's built-in auto-retry by clicking with a
 * reasonable timeout. If the first candidate detaches, move to the next.
 * After clicking, wait for .xterm to confirm the terminal was created.
 */
async function selectShellFromPicker(page: Page): Promise<void> {
  // First check if a terminal is already visible (no picker needed)
  const xtermAlreadyVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermAlreadyVisible) return

  // Wait a moment for the PanePicker to stabilize after WS connection
  // (platform info arrives and may change the option set)
  await page.waitForTimeout(500)

  // Check again - maybe the terminal appeared during the wait
  const xtermNow = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermNow) return

  // Try each shell option. Use a short timeout per attempt since we want
  // to fall through to the next option quickly if one isn't present.
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      // click({ timeout: 5000 }) uses Playwright's auto-retry, which handles
      // transient detachments by re-querying the locator
      await button.click({ timeout: 5000 })
      // Wait for .xterm to appear, confirming terminal was created
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    } catch {
      // This shell option wasn't available or click failed; try next
      continue
    }
  }

  // If none of the named buttons worked, the picker might not be showing
  // (or uses different labels). Fall through and let the test handle it.
}

/**
 * Extended Playwright test fixtures for Freshell E2E tests.
 *
 * Provides:
 * - testServer: An isolated Freshell server instance
 * - serverInfo: Connection info for the test server
 * - harness: TestHarness for Redux state assertions
 * - terminal: TerminalHelper for xterm.js interaction
 * - freshellPage: A page pre-navigated to Freshell with harness ready
 */
export const test = base.extend<{
  serverInfo: E2eServerInfo
  harness: TestHarness
  terminal: TerminalHelper
  freshellPage: Page
  /**
   * RESTORE-01 — whether the harness answers the rust server's designed
   * recover-my-panes offer on fresh-context boots. Default 'auto-decline'
   * clicks the real "Not now" button (docs/plans/df1/RESTORE-01.md). Specs
   * that OWN panel assertions opt out: test.use({ recoveryOfferHandling: 'manual' }).
   */
  recoveryOfferHandling: RecoveryOfferHandling
  /** Select this test's isolated server-owned machine before App bootstrap. */
  machineIdentityHandling: MachineIdentityHandling
  /** Stable server-owned machine shared by contexts inside this test. */
  e2eMachineId: string
}, {
  // NOTE: testServer is worker-scoped, so its TYPE belongs in the
  // worker-scope generic group — declaring it in the test-scope group used to
  // produce the TS2322 "worker-scope tuple" noise (and cascaded the whole
  // extended type to a degraded map, hiding genuine option keys from
  // test.use). Type-level correction; the fixture object below is unchanged.
  testServer: E2eServerHandle
}>({
  recoveryOfferHandling: ['auto-decline', { option: true }],
  machineIdentityHandling: ['auto-select', { option: true }],

  // RESTORE-01 — every page of the default context carries the
  // recovery-offer auto-decline watcher (the harness answering a designed
  // NOTHING (the route is absent there — byte-identical behavior). The
  // built-in `context` is overridden, so spec-authored
  // `browser.newContext()` pages bypass it; those specs use the exported
  // context helpers to install their intended machine before boot.
  context: async ({ context, recoveryOfferHandling, machineIdentityHandling, e2eMachineId, testServer }, use) => {
    if (recoveryOfferHandling === 'auto-decline') {
      installRecoveryOfferAutoDeclineOnContext(context)
    }
    if (machineIdentityHandling === 'auto-select') {
      await installE2eMachineIdentity(context, testServer.info, e2eMachineId)
    }
    await use(context)
  },

  // The server handle is scoped per-worker for efficiency: each test file
  // shares one server.
  //
  // Seam (T3 oracle): when FRESHELL_E2E_TARGET_URL is set, createE2eServerHandle
  // returns a handle that points at an already-running EXTERNAL server (e.g. the
  // Rust port) instead of spawning a fresh local owned RustServer.
  testServer: [async ({}, use) => {
    const server = await createE2eServerHandle(process.env)
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],

  // Each test gets a distinct machine so the worker-scoped server cannot
  // restore the preceding test's workspace into a fresh browser context.
  // The id remains stable for every context that one test intentionally uses.
  e2eMachineId: async ({ testServer }, use) => {
    await use((await registerE2eMachine(testServer.info)).id)
  },

  serverInfo: async ({ testServer }, use) => {
    await use(testServer.info)
  },

  harness: async ({ page }, use) => {
    await use(new TestHarness(page))
  },

  terminal: async ({ page }, use) => {
    await use(new TerminalHelper(page))
  },

  freshellPage: async ({ page, serverInfo, harness }, use) => {
    // Navigate to Freshell with auth token and test harness enabled
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Wait for the test harness to be installed
    await harness.waitForHarness()

    // Wait for WebSocket to connect
    await harness.waitForConnection()

    // If a PanePicker is showing (new tab without auto-created terminal),
    // select a shell to create a terminal. On WSL/Windows the picker shows
    // CMD/PowerShell/WSL instead of a generic "Shell".
    //
    // Race condition: The PanePicker options depend on `connection.platform`
    // from Redux. When the WS handshake completes, platform info arrives and
    // the options list may change (e.g., "Shell" → "CMD/PowerShell/WSL"),
    // detaching the old buttons mid-click. We handle this by:
    // 1. Waiting briefly for the PanePicker to stabilize after connection
    // 2. Using a retry loop with force-click to handle transient detachments
    await selectShellFromPicker(page)

    await use(page)

    // Cleanup: Kill all terminals to prevent PTY accumulation across tests.
    // The server is worker-scoped (shared across tests in a spec file),
    // so terminals from previous tests would otherwise pile up.
    await harness.killAllTerminals(serverInfo)
  },
})

export { expect } from '@playwright/test'
