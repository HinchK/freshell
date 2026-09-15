import { test, expect } from '../helpers/fixtures.js'
import { ensureRustServerBuilt, RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

/**
 * LOCAL-FIRST RELOAD (the-usual/pane-title-recovery, Choice B):
 *
 * 1. A reload of a window whose local layout is HEALTHY keeps the local
 *    workspace exactly — tab ids, order, titles, pane titles, active tab —
 *    with no server-side rebuild (no re-minting).
 * 2. A reload after the local envelope is CORRUPTED rebuilds from the
 *    machine-bootstrap inventory, which (upgrade 1) includes the window's
 *    own last pushed snapshot with PRESERVED tab and pane ids.
 *
 * Cloud-runnable by construction: editor panes (no PTY, no CLI binaries),
 * owned fresh RustServer (fresh FRESHELL_HOME auto-creates the machine —
 * never the chooser), explicit tab/pane ids dispatched through the harness.
 */
test.describe('local-first machine workspace', () => {
  test.describe.configure({ mode: 'serial' })

  let server: RustServer
  let serverInfo: Awaited<ReturnType<RustServer['start']>>

  /** Machine-selection storage payload captured from Scenario 1 (the first
   * serial test): the remembered-selection localStorage entries
   * ('freshell.machine-id.v1' + 'freshell.machine-selections.v1',
   * storage-keys.ts:17-18). Scenario 3 (Task 7 Step 6) opens a FRESH
   * per-test context against this already-existing machine; a first
   * navigation there would open the machine chooser (machine-identity.ts:
   * 216-222: no remembered selection + machines present → chooser) and never
   * connect, so Scenario 3 seeds this payload into its context BEFORE first
   * navigation. Serial mode guarantees Scenario 1 ran first. */
  let machineSelectionStorage: Record<string, string> | undefined

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    server = new RustServer()
    serverInfo = await server.start()
  })
  test.afterAll(async () => { await server?.stop() })

  const TABS = [
    { id: 'tab-mango', title: 'Mango', file: '/tmp/mango.md', pane: 'tab-mango-pane', paneTitle: 'Mango notes' },
    { id: 'tab-apple', title: 'Apple', file: '/tmp/apple.md', pane: 'tab-apple-pane', paneTitle: 'Apple notes' },
  ]

  /** Spec-LOCAL fs-poll (the donor idiom, recover-my-panes-rust.spec.ts:452-494,
   * per LB-07 — there is NO TestHarness method of this name; TestHarness's
   * real methods are only waitForHarness/waitForConnection/waitForTabCount/
   * getState/... per helpers/test-harness.ts): read every generation file
   * under the server home's tabs-snapshots dir, keep only the given
   * clientInstanceId's, rank newest by (snapshotRevision, capturedAt) — the
   * server's own per-client monotonic ordering — and insist the newest
   * generation has >= minRecords records. Bounded, 500ms poll interval. */
  async function waitForNewestGenerationRecordCount(
    clientInstanceId: string,
    minRecords: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const snapshotsDir = path.join(serverInfo.homeDir, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    let lastObserved = 0
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.json'))
        let newest: { revision: number; capturedAt: number; count: number } | null = null
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try { doc = JSON.parse(raw) } catch { continue }
          if (doc?.clientInstanceId !== clientInstanceId) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const count = Array.isArray(doc?.records) ? doc.records.length : 0
          if (!newest || revision > newest.revision || (revision === newest.revision && capturedAt > newest.capturedAt)) {
            newest = { revision, capturedAt, count }
          }
        }
        if (newest) {
          lastObserved = Math.max(lastObserved, newest.count)
          if (newest.count >= minRecords) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `No persisted generation for client ${clientInstanceId} reached ${minRecords} records `
      + `within ${timeoutMs}ms (last observed: ${lastObserved})`,
    )
  }

  test('reload keeps a healthy local workspace exactly; corrupt envelope rebuilds from own snapshot with preserved ids', async ({ page }) => {
    // NO addInitScript at all: a fresh Playwright context starts with EMPTY
    // storage, so there is nothing to clear — and any init script (even a
    // once-guarded clear) cannot survive a reload (each reload is a new
    // document), so it would run on every load and mint a fresh
    // clientInstanceId, letting Scenario 2 pass even if the
    // machine-bootstrap prefix regressed (the LB-08 false green). With no
    // init script the natural reload PRESERVES the clientInstanceId, which
    // makes the `machine-bootstrap:` prefix load-bearing for Scenario 2.
    // LB-07: `connect` is donor-spec-local — navigate directly instead.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Capture the resolved machine-selection storage payload at spec scope
    // (see the machineSelectionStorage declaration): the boot has resolved
    // and persisted the auto-created machine by now (resolveMachineIdentity
    // → persistSelectedMachineId, machine-identity.ts:208/:217-218).
    machineSelectionStorage = await page.evaluate(() => {
      const out: Record<string, string> = {}
      for (const key of ['freshell.machine-id.v1', 'freshell.machine-selections.v1']) {
        const value = localStorage.getItem(key)
        if (value !== null) out[key] = value
      }
      return out
    })

    // Fresh home auto-created a machine AND an auto shell tab. Remove it
    // AFTER our own tabs exist: the App's ensure-at-least-one-tab effect
    // (App.tsx:1889) re-creates a tab whenever tabs.length hits 0, so
    // removing it first would mint a replacement auto tab (three tabs total
    // in the workspace and the envelope). tabs/removeTab takes the BARE
    // tab-id string (tabsSlice.ts:354-355, PayloadAction<string>) — not an
    // { id } object.
    await harness.waitForTabCount(1)
    const autoTabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.[0]?.id)

    for (const t of TABS) {
      await page.evaluate((t) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: t.id, paneId: t.pane,
            content: { kind: 'editor', filePath: t.file, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
          },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/updatePaneTitle', payload: { tabId: t.id, paneId: t.pane, title: t.paneTitle, setByUser: true } })
      }, t)
    }
    await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id }), 'tab-mango')
    await page.evaluate((autoId) => {
      // Mirror the real close path: the closeTab thunk (tabsSlice.ts:703)
      // removes the tab AND its layout (panesSlice removeLayout clears
      // layouts/activePane/paneTitles for the tab). A bare tabs/removeTab
      // would leave an orphaned panes layout for the removed tab in the
      // flushed envelope — which the layout-health classifier correctly
      // flags corrupt, forcing the rebuild this scenario must NOT take.
      // tabs/removeTab takes the BARE tab-id string (tabsSlice.ts:354-355,
      // PayloadAction<string>) — not an { id } object.
      if (!autoId) return
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/removeLayout', payload: { tabId: autoId } })
    }, autoTabId)

    // Wait until the registry pushed generations AND the persisted envelope
    // carries the stamp + both tabs (fs-poll generation files under the
    // server home; localStorage poll for freshell.layout.v3). The page's
    // clientInstanceId lives in sessionStorage (storage-keys.ts:20 — the
    // natural reload preserves it, which is what makes the
    // `machine-bootstrap:` prefix load-bearing in Scenario 2).
    const clientInstanceId = await page.evaluate(() => sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
    await waitForNewestGenerationRecordCount(clientInstanceId, 2)
    await waitForPersistedEnvelope(page, (env) =>
      typeof env.machineId === 'string' && env.machineId.length > 0 && env.tabs?.tabs?.length === 2)

    // ── Scenario 1: healthy reload keeps everything ────────────────
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const kept = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(kept.tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-mango', 'tab-apple'])
    expect(kept.tabs.tabs.map((t: { title: string }) => t.title)).toEqual(['Mango', 'Apple'])
    expect(kept.tabs.activeTabId).toBe('tab-mango')
    expect(kept.panes.paneTitles['tab-mango']['tab-mango-pane']).toBe('Mango notes')
    expect(kept.panes.paneTitles['tab-apple']['tab-apple-pane']).toBe('Apple notes')
    expect(kept.panes.paneTitleSetByUser['tab-mango']['tab-mango-pane']).toBe(true)
    expect(JSON.stringify(kept.panes.layouts['tab-mango'])).toContain('tab-mango-pane')

    // ── Scenario 2: corrupt envelope → bootstrap rebuild, ids preserved ──
    // The corruption must land in storage at teardown, AFTER the live
    // page's own persist middleware flushes its healthy in-memory state:
    // the debounced flush and the pagehide/beforeunload flushNow both
    // rewrite freshell.layout.v3, so corrupting from a live page is always
    // overwritten before the next boot reads it. Listeners registered here
    // run AFTER the middleware's own (attached at module init), so the
    // keys are corrupted last and no further write can precede the next
    // boot. Both the primary envelope AND the pre-migration backup key must
    // go: readRecoverablePersistedLayoutRaw (persistedState.ts:523) heals
    // a primary that does not parse from the backup, which every boot's
    // migration keeps fresh.
    await page.evaluate(() => {
      const corrupt = () => {
        localStorage.setItem('freshell.layout.v3', '{corrupted-by-e2e')
        localStorage.setItem('freshell.layout.v3.backup-before-fresh-agent-centralization', '{corrupted-by-e2e')
      }
      window.addEventListener('beforeunload', corrupt)
      window.addEventListener('pagehide', corrupt)
    })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const rebuilt = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(rebuilt.tabs.tabs.map((t: { id: string }) => t.id).sort()).toEqual(['tab-apple', 'tab-mango'])
    expect(rebuilt.tabs.tabs.map((t: { title: string }) => t.title).sort()).toEqual(['Apple notes', 'Mango notes'])
    expect(JSON.stringify(rebuilt.panes.layouts['tab-mango'])).toContain('tab-mango-pane')
    expect(JSON.stringify(rebuilt.panes.layouts['tab-apple'])).toContain('tab-apple-pane')
  })
})

/** Bounded node-side poll for the persisted envelope to satisfy the
 * predicate: evaluate a plain JSON.parse read each round (no serialized
 * predicate, no `new Function`), assert the predicate in node, keep the
 * poll bounded (10s default) with a clear timeout error. */
async function waitForPersistedEnvelope(
  page: Page,
  predicate: (env: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | null = null
  while (Date.now() < deadline) {
    const env = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('freshell.layout.v3') ?? 'null') } catch { return null }
    })
    if (env && predicate(env)) return
    last = env
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `persisted envelope did not satisfy the predicate within ${timeoutMs}ms; `
    + `last observed: ${JSON.stringify(last)?.slice(0, 400)}`,
  )
}
