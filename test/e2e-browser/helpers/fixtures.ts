import {
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test'
import { type E2eServerInfo } from './server-fixture-support.js'
import {
  TestHarness,
  isCloudLaneWindowConfigured,
  resolveCloudLaneTestBudgetMs,
  selectShellFromPicker,
  shouldExtendTestDeadlineToCloudBudget,
} from './test-harness.js'
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

/** Register a machine the Rust server will accept before an isolated context boots.
 * The registration fetch is independently bounded (delta review r5): an
 * unbounded fetch would be the only un-wedged-limited operation left in a
 * test chain whose deadline is unlimited (the contract spec's declared-0
 * pin resolves exactly this fixture). */
export async function registerE2eMachine(
  serverInfo: E2eServerInfo,
  label = `Playwright test machine ${Date.now()}`,
): Promise<E2eMachine> {
  const headers = { 'x-auth-token': serverInfo.token }
  const created = await fetch(`${serverInfo.baseUrl}/api/machines`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
    signal: AbortSignal.timeout(30_000),
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
 * Create a page backed by a newly registered machine for a spec-owned server.
 * The returned context owns the page and must be closed by the caller before
 * that server is stopped.
 */
export async function createFreshE2ePage(
  browser: Browser,
  serverInfo: E2eServerInfo,
  options?: BrowserContextOptions,
): Promise<{ context: BrowserContext; page: Page; machine: E2eMachine }> {
  const { context, machine } = await createFreshE2eBrowserContext(browser, serverInfo, options)
  try {
    const page = await context.newPage()
    return { context, page, machine }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
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
    const server = await createE2eServerHandle(process.env, {
      // Server-log visibility (kata j90s): the owned RustServer captures
      // stdout/stderr into in-memory buffers unless `verbose` pipes them
      // to this process's console (rust-server.ts). On the cloud lane
      // (FRESHELL_E2E_SERVER_VERBOSE=1, set by scripts/e2e-cloud.sh) that
      // forwards the server's logs into the container log stream so a
      // future wedge episode is diagnosable from Cloud Logging. No-op for
      // external targets (construct is ignored there) and locally.
      construct: { verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1' },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],

  // Each test gets a distinct machine so the worker-scoped server cannot
  // restore the preceding test's workspace into a fresh browser context.
  // The id remains stable for every context that one test intentionally uses.
  //
  // Cloud-lane wedge budget (kata tg4e): this is the earliest test-scoped
  // fixture — resolved before context/page, so every module-chain spec's
  // whole fixture chain runs under the deadline set here. The freshellPage
  // fixture's boot chain — self-healing waitForConnection (at most W+1s,
  // a single total deadline) plus the picker/render tail (kata tg4e's
  // retained trace: a container-wide CPU-contention episode starved the
  // post-click .xterm render and the old picker loop silently burned the
  // remaining budget escalating through options absent on this platform) —
  // has a permitted-composed envelope (connection W+1s + picker worst + start reserve) larger than the config's 60s default,
  // which killed fixture setup mid-envelope: the recorded
  // "Test timeout of 60000ms exceeded while setting up freshellPage"
  // flake. Extending the deadline from inside this fixture makes the
  // budget cover the chain's envelope for every module-chain spec, not
  // just settings.spec.ts (whose private hook Task 5 removes). Locally
  // the env var is unset and the default budget applies unchanged. The
  // mechanism is probe-verified (settings.spec.ts precedent, kata j90s):
  // a setTimeout issued during fixture resolution extends the live
  // deadline over fixture time. EXTEND-ONLY and DEFAULT-CLASS-ONLY (delta
  // review r5): specs that declare a deadline above the config default —
  // idle-gate 300s, reconcile 240s, launch-retry-restart-rust 180s — keep
  // their own budget, whatever the composition: raising an explicit spec
  // budget decision would touch other flakes' mechanisms, and their own
  // deflake runs must fix any under-budgeting. A declared 0 is
  // Playwright's UNLIMITED: any finite budget would shrink it. All three
  // rules live in the unit-tested shouldExtendTestDeadlineToCloudBudget.
  e2eMachineId: async ({ testServer }, use) => {
    const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
    if (
      cloudBudgetMs !== null
      && shouldExtendTestDeadlineToCloudBudget(test.info().timeout, cloudBudgetMs)
    ) {
      test.info().setTimeout(cloudBudgetMs)
    }
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

    // Wait for WebSocket to connect. Self-heal is opted IN on the cloud
    // lane only (window env configured — one presence rule shared with the
    // budget resolver, kata tg4e): this is a fresh-boot wait, and the j90s
    // wedge class (a gVisor I/O stall hanging a timeout-less boot fetch so
    // the WS never starts) recovers via a fresh boot chain —
    // waitForConnection performs at most ONE mid-wait reload when ready
    // has not landed by half the window (kata j90s). The local lane keeps
    // its exact historical single-shot wait semantics, and a stray EMPTY
    // export means "unset" everywhere (self-heal and budget agree).
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })

    // If a PanePicker is showing (new tab without auto-created terminal),
    // select a shell to create a terminal. On WSL/Windows the picker shows
    // CMD/PowerShell/WSL instead of a generic "Shell".
    //
    // The picker options depend on `connection.platform` from Redux and may
    // change as the handshake settles (detaching buttons mid-click). The
    // shared helper (kata tg4e) handles that: a not-clickable option
    // advances to the next candidate, and a successful click waits out the
    // render envelope without escalating — see selectShellFromPicker in
    // test-harness.ts for the full contract.
    await selectShellFromPicker(page)

    await use(page)

    // Cleanup: Kill all terminals to prevent PTY accumulation across tests.
    // The server is worker-scoped (shared across tests in a spec file),
    // so terminals from previous tests would otherwise pile up.
    await harness.killAllTerminals(serverInfo)
  },
})

export { expect } from '@playwright/test'
