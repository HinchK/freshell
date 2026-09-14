import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * MACHINE-TAB-ORDER (the-usual/tabs-union-order): the tab strip's ORDER must
 * survive a reload that goes through the machine-identity workspace restore.
 *
 * The regression: `union_of_newest_per_client`
 * (crates/freshell-ws/src/tabs_persist.rs) deduped the tabs-registry
 * generations into a HashMap keyed by tabKey and emitted the union records
 * SORTED BY TABKEY — arbitrary relative to the strip (tabKey is
 * `<machineId>:<tabId>`). On every boot with a resolved machine,
 * `restoreMachineWorkspace` (src/lib/machine-workspace.ts) replaces the
 * local tabs with `inv.device.tabs` in union order — so a restart/refresh
 * scrambled the strip.
 *
 * Deterministic failure shape: tabs are created with EXPLICIT ids
 * (tab-mango, tab-apple, tab-zebra) in that order, so the buggy tabKey sort
 * yields exactly [tab-apple, tab-mango, tab-zebra] — distinct from the
 * creation order.
 *
 * Why the restore sees the pre-reload tabs: sessionStorage is cleared on
 * every navigation (addInitScript below), so the reloaded page mints a NEW
 * clientInstanceId; the recovery inventory then treats the pre-reload
 * generations as a FOREIGN client's (A15/A16: captured before this boot)
 * and `build_inventory` rebuilds `device.tabs` from them. The machine id
 * itself lives in localStorage and survives the reload, so resolution is
 * 'selected' (not the chooser) and the restore path runs before the WS.
 *
 * Owns a RustServer directly (ephemeral loopback port, fresh temp HOME ⇒
 * empty machines store ⇒ deterministic machine auto-create; the fixtures'
 * shared rust testServer carries other specs' machines/generations).
 * Service workers blocked per the recover-my-panes PWA note: the SW's
 * controllerchange reload races the boot inventory fetch.
 */
let server: RustServer | null = null
let info: { baseUrl: string; token: string } | null = null
let capturedHome = ''

test.beforeAll(async () => {
  test.setTimeout(600_000) // first release build of freshell-server can take minutes
  ensureRustServerBuilt()
  server = new RustServer({
    setupHome: async (homeDir: string) => {
      capturedHome = homeDir
    },
  })
  info = await server.start()
})

test.afterAll(async () => {
  await server?.stop().catch(() => {})
})

/**
 * Wait until the NEWEST persisted tabs-snapshot generation for the given
 * client carries EXACTLY the expected tab ids — copied and adapted from
 * recover-my-panes-rust.spec.ts's waitForNewestGenerationRecordCount
 * (same fs-poll idiom; snapshot pushes fire on ready + every 5s, so the
 * generation files lag the UI by seconds). Reading the files proves the
 * server DURABLY persisted the strip before the reload (a sent
 * tabs.sync.push frame does not).
 */
async function waitForNewestGenerationTabs(
  clientInstanceId: string,
  expectedTabIds: string[],
  timeoutMs = 30_000,
): Promise<void> {
  const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
  const deadline = Date.now() + timeoutMs
  let lastObserved = 'none'
  while (Date.now() < deadline) {
    const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
    for (const device of devices) {
      const deviceDir = path.join(snapshotsDir, device)
      const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith('.json'))
      let newest: { revision: number; capturedAt: number; tabIds: string[] } | null = null
      for (const f of files) {
        const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
        let doc: any = null
        try {
          doc = JSON.parse(raw)
        } catch {
          continue
        }
        if (doc?.clientInstanceId !== clientInstanceId) continue
        const revision = Number(doc?.snapshotRevision ?? 0)
        const capturedAt = Number(doc?.capturedAt ?? 0)
        const tabIds: string[] = Array.isArray(doc?.records)
          ? doc.records.map((r: any) => r?.tabId).filter((id: any) => typeof id === 'string')
          : []
        if (!newest || revision > newest.revision
          || (revision === newest.revision && capturedAt > newest.capturedAt)) {
          newest = { revision, capturedAt, tabIds }
        }
      }
      if (newest) {
        lastObserved = JSON.stringify(newest.tabIds)
        const sortedSeen = [...newest.tabIds].sort()
        const sortedWant = [...expectedTabIds].sort()
        if (sortedSeen.length === sortedWant.length
          && sortedSeen.every((id, i) => id === sortedWant[i])) {
          return
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `Newest persisted generation for client ${clientInstanceId} never held exactly `
    + `[${expectedTabIds.join(', ')}] within ${timeoutMs}ms (last observed: ${lastObserved})`,
  )
}

test.describe('machine workspace restore keeps tab order', () => {
  test('a reload restores the tab strip in the pushed strip order', async ({ browser }) => {
    // Post-#699 (Node-server retirement) there is a single rust-only e2e
    // surface: this spec owns its RustServer directly and runs under the
    // default chromium project — no e2eServerKind guard to assert.
    test.setTimeout(240_000)

    const ctx: BrowserContext = await browser.newContext({ serviceWorkers: 'block' })
    const page: Page = await ctx.newPage()
    await page.addInitScript(() => { sessionStorage.clear() })
    await page.goto(`${info!.baseUrl}/?token=${info!.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The first-boot auto-create (App.tsx:1871-1876) fires on EVERY render
    // where a ready machine has ZERO tabs — so the auto tab must be removed
    // LAST, never first: removing it before adding ours would expose an
    // empty strip for one render and deterministically inject a fresh
    // random-id shell tab. Capture its id now; add our three tabs (strip
    // 1 -> 4); then remove the auto tab (strip 4 -> 3) so the strip never
    // passes through zero.
    await harness.waitForTabCount(1, 30_000)
    const bootState: any = await harness.getState()
    const autoTabId: string = bootState?.tabs?.tabs?.[0]?.id
    expect(autoTabId, 'the auto-created first tab exists before our tabs').toBeTruthy()

    // Three tabs with explicit ids, created in an order that differs from
    // tabKey sort. Editor panes: no PTY spawn, and the recovery plan
    // round-trips editor payloads (build-recovery-plan.ts, the D6 rule).
    const tabs = [
      { id: 'tab-mango', title: 'Mango', file: '/tmp/mango.md' },
      { id: 'tab-apple', title: 'Apple', file: '/tmp/apple.md' },
      { id: 'tab-zebra', title: 'Zebra', file: '/tmp/zebra.md' },
    ]
    for (const tab of tabs) {
      await page.evaluate((t: typeof tabs[number]) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: t.id,
            paneId: `${t.id}-pane`,
            content: {
              kind: 'editor', filePath: t.file, language: null,
              readOnly: false, content: '', viewMode: 'source', wordWrap: true,
            },
          },
        })
      }, tab)
    }
    await harness.waitForTabCount(4, 30_000) // three explicit tabs + the auto tab
    await page.evaluate((tabId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: tabId })
    }, autoTabId)
    await harness.waitForTabCount(3, 30_000)

    // Durable-persist wait: the client's NEWEST generation on disk holds
    // exactly the three tab ids before we reload.
    const clientInstanceId = await page.evaluate(() =>
      window.sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
    expect(clientInstanceId, 'the page claimed a tabs-registry clientInstanceId').toBeTruthy()
    await waitForNewestGenerationTabs(clientInstanceId!, ['tab-mango', 'tab-apple', 'tab-zebra'])

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The restore replaced the local strip before the WS connected; wait
    // for the three tabs and pin the exact order. Before the union fix the
    // received order is the tabKey sort ['Apple', 'Mango', 'Zebra'].
    await expect.poll(async () => {
      const state: any = await harness.getState()
      return (state?.tabs?.tabs ?? []).map((t: any) => t.title)
    }, { timeout: 20_000 }).toEqual(['Mango', 'Apple', 'Zebra'])
  })
})
