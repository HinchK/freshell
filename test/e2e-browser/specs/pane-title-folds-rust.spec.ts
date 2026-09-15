import { test, expect } from '../helpers/fixtures.js'
import { ensureRustServerBuilt, RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * PANE-TITLE DELIVERY FOLDS (the-usual/pane-title-recovery, Tasks 5-6):
 *
 * 1. terminal.inventory folds registry terminal titles into pane titles on
 *    every connect. Pinned end-to-end via a REST terminal rename
 *    (`PATCH /api/terminals/:id` with `titleOverride`): the PATCH
 *    broadcasts `terminals.changed` — NOT `terminal.title.updated` — so the
 *    live pane-title fold never fires for it, and the reload's
 *    terminal.inventory frame is the ONLY delivery of the renamed title.
 *    Scenario A also pins the delta-round-2 finding-1 precedence: the
 *    session-directory title mirror targets FRESH-AGENT panes only, so
 *    binding the (session-less) shell pane to a seeded Claude session row
 *    must NOT overwrite the folded terminal rename.
 * 2. The session-directory title mirror lands in a harness-dispatched
 *    fresh-agent pane whose provider+sessionId match a seeded, NON-RUNNING
 *    Claude session row — the MCP/REST-created-pane symptom Task 6 fixes —
 *    with setByUser:false so user renames keep precedence.
 *
 * Cloud-runnable by construction: no external coding-CLI binaries
 * (Scenario A's pane is a default shell; Scenario B's pane is a
 * store-dispatched fresh-agent pane against a seeded, non-running session —
 * nothing spawns). One OWNED RustServer per scenario (fresh FRESHELL_HOME,
 * no chooser) so each scenario's seeded home never sees the other's
 * terminal.
 */

/** Seed a Claude session row the recover-my-panes way: system/init line,
 * then TWO user/assistant turn pairs — a single-user-message session is
 * flagged isNonInteractive and hidden by the directory. The row's
 * sessionId is the transcript FILENAME (Claude's provider identity). */
function writeSeededClaudeSession(
  homeDir: string,
  sessionId: string,
  projectSlug: string,
  firstUserMessage: string,
  timestampBase: string,
): void {
  const sessionDir = path.join(homeDir, '.claude', 'projects', projectSlug)
  fs.mkdirSync(sessionDir, { recursive: true })
  const projectCwd = path.join(homeDir, projectSlug)
  const seededLines: string[] = [
    JSON.stringify({
      type: 'system', subtype: 'init', session_id: sessionId,
      uuid: `${sessionId}-system`, timestamp: `${timestampBase}:00.000Z`,
      cwd: projectCwd, git: { branch: 'main', dirty: false },
    }),
  ]
  let previousUuid = `${sessionId}-system`
  const messages = [firstUserMessage, 'Any progress on that request?']
  for (const [turnIndex, userMessage] of messages.entries()) {
    const userUuid = `${sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${sessionId}-assistant-${turnIndex + 1}`
    seededLines.push(JSON.stringify({
      parentUuid: previousUuid, cwd: projectCwd, sessionId,
      version: '2.1.23', gitBranch: 'main', type: 'user',
      message: { role: 'user', content: userMessage },
      uuid: userUuid, timestamp: `${timestampBase}:0${turnIndex}:01.000Z`,
    }))
    seededLines.push(JSON.stringify({
      parentUuid: userUuid, cwd: projectCwd, sessionId,
      version: '2.1.23', gitBranch: 'main', type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `Working on it (${turnIndex + 1}).` }],
      },
      uuid: assistantUuid, timestamp: `${timestampBase}:0${turnIndex}:02.000Z`,
    }))
    previousUuid = assistantUuid
  }
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), `${seededLines.join('\n')}\n`)
}

test.describe('pane-title delivery folds', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
  })

  test('terminal.inventory folds a REST terminal rename into the pane title after reload', async ({ page }) => {
    test.setTimeout(300_000)
    const BIND_SESSION_ID = 'sess-t8-a-bound'
    const server = new RustServer({
      setupHome: async (homeDir) => {
        writeSeededClaudeSession(homeDir, BIND_SESSION_ID, 't8-precedence-probe', 't8 session-bound rename probe', '2026-09-14T09:00')
      },
    })
    const serverInfo = await server.start()
    try {
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // Remove the auto-created shell tab first (Task 4's idiom: read the
      // tab id from the harness state, dispatch tabs/removeTab with the BARE
      // id string, and mirror the real closeTab thunk's panes/removeLayout
      // so no orphaned layout survives in the persisted envelope).
      await harness.waitForTabCount(1)
      const autoTabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.[0]?.id)
      await page.evaluate((autoId) => {
        if (!autoId) return
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/removeLayout', payload: { tabId: autoId } })
      }, autoTabId)

      // Create a shell terminal pane. 'creating' is a real TerminalStatus
      // and the WS-flap create re-drive requires it; the mounted pane's
      // TerminalView drives terminal.create from the createRequestId while
      // the content has no terminalId, and the WS terminal.created fold
      // writes the real id into the pane content.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-t8-a', title: 'Inventory fold' } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: 'tab-t8-a', paneId: 'pane-t8-a',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-t8-a', status: 'creating' },
          },
        })
      })
      await page.waitForFunction(() => {
        const content = window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.layouts?.['tab-t8-a']?.content
        const id = content?.kind === 'terminal' ? content.terminalId : undefined
        return typeof id === 'string' && id.length > 0
      }, undefined, { timeout: 30_000 })
      const terminalId = await page.evaluate(() => {
        const content = window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.layouts?.['tab-t8-a']?.content
        return content?.kind === 'terminal' ? content.terminalId : undefined
      })
      expect(terminalId, 'the pane content carries a real terminalId').toBeTruthy()

      // Rename the terminal over REST. The auto-title sweep is structurally
      // blind to terminal renames, and the PATCH broadcasts
      // terminals.changed — NOT terminal.title.updated — so the live
      // terminal.title.updated pane-title fold never fires for this rename;
      // the PATCH's registry write-through is what the reload's inventory
      // rows read. Route verified: handler patch_terminal
      // (crates/freshell-server/src/terminals.rs:908), field titleOverride.
      const response = await fetch(`${serverInfo.baseUrl}/api/terminals/${terminalId}`, {
        method: 'PATCH',
        headers: { 'x-auth-token': serverInfo.token, 'content-type': 'application/json' },
        body: JSON.stringify({ titleOverride: 'Renamed via REST' }),
      })
      expect(response.status).toBe(200)

      // Reload: the server sends terminal.inventory on every connect, and
      // Task 5's fold is the only delivery path for the renamed title.
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.paneTitles?.['tab-t8-a']?.['pane-t8-a'] === 'Renamed via REST',
        undefined, { timeout: 15_000 })
      const state = await harness.getState()
      expect(state.panes.paneTitles['tab-t8-a']['pane-t8-a']).toBe('Renamed via REST')
      expect(state.panes.paneTitleSetByUser?.['tab-t8-a']?.['pane-t8-a'] ?? false).toBeFalsy()

      // Delta review round 2, finding 1 — end-to-end precedence pin: bind
      // this shell pane to a seeded, titled Claude session row via the
      // REAL session-association fold (terminal.session.associated's
      // client handler dispatches panes/reconcileTerminalSessionRefByTerminalId,
      // terminal-session-association.ts:245 — mirrored here by the harness
      // dispatch). The session mirror must target FRESH-AGENT panes only:
      // the folded terminal rename survives the binding and every later
      // sessions/* commit (the mirror fires synchronously on the binding
      // action — sessionTitleMirror.ts SESSION_BINDING_PANE_ACTIONS).
      await page.waitForFunction((sessionId) => {
        const projects = window.__FRESHELL_TEST_HARNESS__?.getState()?.sessions?.windows?.sidebar?.projects ?? []
        for (const project of projects) {
          for (const session of project?.sessions ?? []) {
            if (session?.provider === 'claude' && session?.sessionId === sessionId
              && typeof session?.title === 'string' && session.title.length > 0
              && session.title !== 'Renamed via REST') {
              return true
            }
          }
        }
        return false
      }, BIND_SESSION_ID, { timeout: 30_000 })

      const bound = await page.evaluate(([tabId, paneId, terminalId, sessionId]) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/reconcileTerminalSessionRefByTerminalId',
          payload: { terminalId, sessionRef: { provider: 'claude', sessionId } },
        })
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        const content = state?.panes?.layouts?.[tabId]?.content
        return {
          sessionRef: content?.kind === 'terminal' ? content.sessionRef : undefined,
          paneTitle: state?.panes?.paneTitles?.[tabId]?.[paneId],
          setByUser: state?.panes?.paneTitleSetByUser?.[tabId]?.[paneId] ?? false,
        }
      }, ['tab-t8-a', 'pane-t8-a', terminalId, BIND_SESSION_ID] as const)
      expect(bound.sessionRef, 'the binding fold landed the sessionRef on the terminal pane').toEqual({
        provider: 'claude',
        sessionId: BIND_SESSION_ID,
      })
      expect(bound.paneTitle).toBe('Renamed via REST')
      expect(bound.setByUser).toBeFalsy()
    } finally {
      await server.stop()
    }
  })

  test('the session-directory title mirrors into a harness-dispatched fresh-agent pane', async ({ page }) => {
    test.setTimeout(300_000)
    const SEED_SESSION_ID = 'sess-t8-b'
    const SEED_PROJECT = 't8-mirror-probe'
    const server = new RustServer({
      setupHome: async (homeDir) => {
        // Seed a Claude session row whose sessionId the fresh-agent pane's
        // provider+sessionId can match directly.
        writeSeededClaudeSession(homeDir, SEED_SESSION_ID, SEED_PROJECT, 't8 mirror probe session', '2026-09-14T08:00')
      },
    })
    const serverInfo = await server.start()
    try {
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // Remove the auto-created shell tab FIRST (Task 4's idiom): the fresh
      // home auto-creates a shell tab whose layout would otherwise own the
      // pane tree alongside the probe pane this scenario asserts on.
      await harness.waitForTabCount(1)
      const autoTabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.[0]?.id)
      await page.evaluate((autoId) => {
        if (!autoId) return
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/removeLayout', payload: { tabId: autoId } })
      }, autoTabId)

      // Poll until the seeded row appears in the sessions window: the App
      // fetches /api/session-directory and the server's live watcher
      // indexes the seeded file without a restart.
      await page.waitForFunction((sessionId) => {
        const projects = window.__FRESHELL_TEST_HARNESS__?.getState()?.sessions?.windows?.sidebar?.projects ?? []
        for (const project of projects) {
          for (const session of project?.sessions ?? []) {
            if (session?.provider === 'claude' && session?.sessionId === sessionId
              && typeof session?.title === 'string' && session.title.length > 0) {
              return true
            }
          }
        }
        return false
      }, SEED_SESSION_ID, { timeout: 30_000 })

      // Create the pane PROPERLY: tabs/addTab with an explicit id first —
      // panes/initLayout no-ops when state.layouts[tabId] already exists and
      // an initLayout for a tab id that was never added would orphan the
      // layout — then panes/initLayout with the normalized fresh-agent
      // content shape whose provider+sessionId match the seeded row. The
      // mirror fires on the pane-binding action with the row already landed.
      await page.evaluate((sessionId) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-mirror', title: 'Mirror probe' } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: 'tab-mirror', paneId: 'pane-mirror',
            content: {
              kind: 'fresh-agent', provider: 'claude', sessionId,
              sessionType: 'freshclaude', sessionRef: { provider: 'claude', sessionId },
            },
          },
        })
      }, SEED_SESSION_ID)

      // One atomic state read (the mirror's fold is synchronous on the
      // pane-binding dispatch): assert the pane title mirrors the row's
      // actual directory title — read, not hard-coded — and that the fold
      // never set the user flag.
      const mirrored = await page.evaluate((sessionId) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        let rowTitle: unknown
        for (const project of state?.sessions?.windows?.sidebar?.projects ?? []) {
          for (const session of project?.sessions ?? []) {
            if (session?.provider === 'claude' && session?.sessionId === sessionId) {
              rowTitle = session?.title
            }
          }
        }
        return {
          rowTitle,
          paneTitle: state?.panes?.paneTitles?.['tab-mirror']?.['pane-mirror'],
          setByUser: state?.panes?.paneTitleSetByUser?.['tab-mirror']?.['pane-mirror'] ?? false,
        }
      }, SEED_SESSION_ID)
      expect(mirrored.rowTitle, 'the seeded session row is titled in the sidebar window').toBeTruthy()
      expect(mirrored.paneTitle).toBe(mirrored.rowTitle)
      expect(mirrored.setByUser).toBeFalsy()
    } finally {
      await server.stop()
    }
  })
})
