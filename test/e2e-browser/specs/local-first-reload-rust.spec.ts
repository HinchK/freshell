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
 * 3. A stale (older persistedAt) envelope written from a second page in the
 *    same context does not clobber this page's newer local pane title — the
 *    Task 7 cross-window recency guard, over the real storage-event
 *    hydration path.
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
    // server home; localStorage poll for the page's per-window layout key).
    // The page's
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
    // rewrite the page's per-window layout key
    // (freshell.layout.v3.<clientInstanceId>), so corrupting from a live
    // page is always overwritten before the next boot reads it. Listeners
    // registered here run AFTER the middleware's own (attached at module
    // init), so the keys are corrupted last and no further write can
    // precede the next boot. Both the primary envelope AND the window's
    // per-window fresh-agent backup key must go:
    // readRecoverablePersistedLayoutRaw (persistedState.ts) heals a
    // primary that does not parse from the backup, which every boot's
    // migration keeps fresh. The sessionStorage clientInstanceId survives
    // the reload, so the derived key is stable across it.
    await page.evaluate(() => {
      const corrupt = () => {
        const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.tabs.client-instance-id.v1')}`
        localStorage.setItem(layoutKey, '{corrupted-by-e2e')
        localStorage.setItem(`${layoutKey}.backup-before-fresh-agent-centralization`, '{corrupted-by-e2e')
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

  test('an older persisted layout from a second page does not clobber a newer local pane title', async ({ page }) => {
    // Establish the remembered machine in this FRESH context BEFORE first
    // navigation (see the donor-idiom note above): seed the payload
    // Scenario 1 captured, then boot page1 — it resolves the seeded machine
    // (kind 'selected', machine-identity.ts:191-214) with NO chooser. This
    // is a SEEDING init script, not the clearing kind LB-08 forbids: it
    // writes the same values the boot itself persists, idempotently, and
    // never touches sessionStorage or the clientInstanceId.
    test.skip(!machineSelectionStorage, 'Scenario 1 must have captured the machine-selection payload')
    await page.addInitScript((payload) => {
      for (const [key, value] of Object.entries(payload)) localStorage.setItem(key, value)
      // Without a freshell_version stamp, runStorageMigration()'s full path
      // (storage-migration.ts:475) wipes every freshell.* key outside its
      // keep list — including the machine-selection keys just seeded — and
      // the boot falls into the chooser. Stamping the current version keeps
      // the migration on its preserve-only early-return path.
      localStorage.setItem('freshell_version', '5')
    }, machineSelectionStorage)

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The seeded context has NO local envelope, so this boot REBUILDS from
    // the machine-bootstrap inventory: Scenario 1's tabs come back with
    // PRESERVED ids (Task 3), exactly as Scenario 2 just pinned — there is
    // no auto shell tab to remove, and tab-mango's restored pane tree
    // already carries the tab-mango-pane pane this scenario titles.
    await harness.waitForTabCount(2)
    await waitForPersistedEnvelope(page, (env) =>
      typeof env.machineId === 'string' && env.machineId.length > 0
      && env.tabs?.tabs?.some((t: { id: string }) => t.id === 'tab-mango'))

    // page2 opens in the SAME context (shared localStorage — the donor's
    // `page.context().newPage()` idiom, multi-client.spec.ts:198-199) and
    // rehydrates the envelope; it resolves the same saved machine (the
    // donor's second-page mechanism, :202/:205-206) — no init script needed.
    const page2 = await page.context().newPage()
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    const harness2 = new TestHarness(page2)
    await harness2.waitForHarness()
    await harness2.waitForConnection()

    // page2 sets a NEWER non-user-set pane title and forces an immediate
    // flush (the donor's flushPersistedLayout idiom, multi-client.spec.ts:
    // 177-185: dispatch 'persist/flushNow'), then poll PAGE2's OWN
    // per-window envelope (delta round 3: the flush writes page2's key —
    // under the old shared key this poll read the same bytes page2 just
    // wrote) until it carries the new title — capturing its persistedAt as
    // tLocal (page2's local stamp).
    await page2.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'panes/updatePaneTitle',
      payload: { tabId: 'tab-mango', paneId: 'tab-mango-pane', title: 'Newer local title', setByUser: false },
    }))
    await page2.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' }))
    const tLocal = await waitForPersistedEnvelopeTitled(page2, 'Newer local title')

    // Let page1's response settle BEFORE staging: page2's flush fires a
    // storage event on page1 (carrying page2's per-window key), whose
    // crossTabSync hydrates the newer title into page1's Redux state (the
    // hydrate dispatches are skipPersist, so page1 schedules no reflush of
    // its own) — wait any cycle out so the staged write below is the LAST
    // envelope write.
    await page.waitForTimeout(2_000)

    // Stage the STALE remote: from page1, mutate PAGE2's OWN per-window
    // envelope in place — same JSON, the pane title reverted, persistedAt
    // 60s OLDER than page2's local stamp (delta round 3, finding 1: the
    // staging must target page2's own derived key, read from its
    // sessionStorage clientInstanceId). page1's cross-document write fires
    // a storage event on page2 carrying page2's own key — the real
    // crossTabSync prefix subscription hydrates page2 with
    // remoteLayoutPersistedAt < localLayoutPersistedAt.
    // Envelope shape verified against the real writer/reader:
    //  - paneTitles live at panes.paneTitles (persistMiddleware.ts:625-654
    //    writes `panes: persistablePanesSection` — the state.panes spread
    //    minus volatile fields; parsed at persistedState.ts:553). The old
    //    sketch's top-level `env.paneTitles` dereferenced undefined and
    //    threw — fixed.
    //  - persistedAt is TOP-LEVEL (persistMiddleware.ts:647, read at
    //    persistedState.ts:557).
    //  - the layout key is the page's per-window key
    //    freshell.layout.v3.<clientInstanceId> (window-layout-keys.ts).
    //  - Task 1's machineId is TOP-LEVEL; the staging touches ONLY the
    //    title and persistedAt, so the stamp (and everything else) is
    //    preserved.
    const page2ClientInstanceId = await page2.evaluate(() => sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
    expect(page2ClientInstanceId, 'page2 has a per-window clientInstanceId in sessionStorage').toBeTruthy()
    await page.evaluate(([tLocal, clientInstanceId]) => {
      const layoutKey = `freshell.layout.v3.${clientInstanceId}`
      const env = JSON.parse(localStorage.getItem(layoutKey) ?? '{}')
      env.panes.paneTitles['tab-mango']['tab-mango-pane'] = 'Stale from page1'
      env.persistedAt = tLocal - 60_000
      localStorage.setItem(layoutKey, JSON.stringify(env))
    }, [tLocal, page2ClientInstanceId] as [number, string | null])

    // Bounded settle for the storage-event hydration, then ONE hard read (not a
    // poll — a poll could sample before the hydrate lands and false-pass).
    await page2.waitForTimeout(2_000)
    const title = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.paneTitles?.['tab-mango']?.['tab-mango-pane'])
    expect(title).toBe('Newer local title')
  })
})

/** Bounded node-side poll for the persisted envelope to satisfy the
 * predicate: evaluate a plain JSON.parse read each round (no serialized
 * predicate, no `new Function`), assert the predicate in node, keep the
 * poll bounded (10s default) with a clear timeout error. Reads the page's
 * per-window layout key (freshell.layout.v3.<clientInstanceId>, delta
 * round 3, finding 1). */
async function waitForPersistedEnvelope(
  page: Page,
  predicate: (env: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | null = null
  while (Date.now() < deadline) {
    const env = await page.evaluate(() => {
      const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.tabs.client-instance-id.v1')}`
      try { return JSON.parse(localStorage.getItem(layoutKey) ?? 'null') } catch { return null }
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

/** Bounded poll until the page's envelope's pane title equals the given
 * value; resolves the envelope's persistedAt (the writer's stamp — tLocal
 * for the page2 flush this scenario tracks). Node-side predicate over one
 * plain JSON.parse read per round (same shape as waitForPersistedEnvelope). */
async function waitForPersistedEnvelopeTitled(
  page: Page,
  expectedTitle: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const persistedAt = await page.evaluate((title) => {
      try {
        const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.tabs.client-instance-id.v1')}`
        const env = JSON.parse(localStorage.getItem(layoutKey) ?? 'null')
        if (env?.panes?.paneTitles?.['tab-mango']?.['tab-mango-pane'] === title
          && typeof env.persistedAt === 'number') {
          return env.persistedAt
        }
        return null
      } catch { return null }
    }, expectedTitle)
    if (typeof persistedAt === 'number') return persistedAt
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`persisted envelope did not carry the pane title '${expectedTitle}' within ${timeoutMs}ms`)
}
