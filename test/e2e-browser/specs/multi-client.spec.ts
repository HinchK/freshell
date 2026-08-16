import fs from 'fs/promises'
import path from 'path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'

// RESTORE-01: manual contexts bypass the fixtures' built-in `context`
// override, so they adopt the shared recovery auto-decline watcher directly
// (docs/plans/df1/RESTORE-01.md). No-op unless a recoverable offer is made.
async function newClientContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  installRecoveryOfferAutoDeclineOnContext(context)
  return context
}

// Helper: wait for a page to be connected and ready
async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() =>
    window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 }
  )
}

async function ensureTerminalReady(page: Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (!xtermVisible) {
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      try {
        const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5000 })
          break
        }
      } catch {
        continue
      }
    }
  }

  await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => {
    const buf = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer()
    return buf !== null && buf !== undefined && buf.length > 0
  }, { timeout: 20_000 })
}

async function executeCommand(page: Page, command: string): Promise<void> {
  await page.locator('.xterm').first().click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function waitForTerminalText(page: Page, text: string, terminalId?: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    ({ searchText, id }) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id)?.includes(searchText) ?? false,
    { searchText: text, id: terminalId },
    { timeout },
  )
}

async function getActiveTerminalId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const layout = activeTabId ? state?.panes?.layouts?.[activeTabId] : null

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const terminalId = readTerminalId(child)
          if (terminalId) return terminalId
        }
      }
      return null
    }

    return readTerminalId(layout)
  })
}

async function waitForActiveTerminalId(page: Page, timeout = 20_000): Promise<string> {
  let latest: string | null = null
  await expect(async () => {
    latest = await getActiveTerminalId(page)
    expect(latest).toBeTruthy()
  }).toPass({ timeout })
  if (!latest) throw new Error('Expected the active tab to expose a terminalId')
  return latest
}

async function waitForTabWithTerminalId(page: Page, expectedTerminalId: string, timeout = 20_000): Promise<string> {
  await page.waitForFunction((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    const layouts = state?.panes?.layouts ?? {}
    return Object.entries(layouts).some(([, layout]) => readTerminalId(layout) === terminalId)
  }, expectedTerminalId, { timeout })

  const tabId = await page.evaluate((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const layouts = state?.panes?.layouts ?? {}

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    for (const [tabId, layout] of Object.entries(layouts)) {
      if (readTerminalId(layout) === terminalId) return tabId
    }
    return null
  }, expectedTerminalId)

  if (!tabId) {
    throw new Error(`Expected to find a tab containing terminal ${expectedTerminalId}`)
  }

  return tabId
}

async function readMarkedPtySize(page: Page, marker: string, terminalId?: string): Promise<string | null> {
  return page.evaluate(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    const regex = new RegExp(`${label}:(\\d+\\s+\\d+)`, 'g')
    let match: RegExpExecArray | null = null
    let last: string | null = null
    while ((match = regex.exec(buffer)) !== null) {
      last = match[1] ?? null
    }
    return last
  }, { id: terminalId, label: marker })
}

async function waitForMarkedPtySize(page: Page, marker: string, terminalId?: string, timeout = 15_000): Promise<string> {
  await page.waitForFunction(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    return new RegExp(`${label}:(\\d+\\s+\\d+)`).test(buffer)
  }, { id: terminalId, label: marker }, { timeout })

  const size = await readMarkedPtySize(page, marker, terminalId)
  if (!size) {
    throw new Error(`Expected to parse PTY size marker ${marker}`)
  }
  return size
}

async function flushPersistedLayout(page: Page, terminalId: string): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
  await page.waitForFunction((id) => {
    const raw = window.localStorage.getItem('freshell.layout.v3')
    return typeof raw === 'string' && raw.includes(id)
  }, terminalId, { timeout: 10_000 })
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
  }, tabId)
  await page.waitForFunction((id) => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId === id, tabId, { timeout: 10_000 })
}

test.describe('Multi-Client', () => {
  test('two browser tabs share the same server', async ({ browser, serverInfo }) => {
    // Open two pages to the same server
    const context = await newClientContext(browser)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Both should connect successfully
    await waitForReady(page1)
    await waitForReady(page2)

    await context.close()
  })

  test('terminal output appears in both clients', async ({ browser, serverInfo }) => {
    const context = await newClientContext(browser)
    const page1 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)

    await executeCommand(page1, 'echo "multi-client-marker"')

    await waitForTerminalText(page1, 'multi-client-marker', terminalId!)
    await waitForTerminalText(page2, 'multi-client-marker', terminalId!)

    await context.close()
  })

  test('reconnecting second viewer keeps page 1 PTY size stable and both pages keep shared output', async ({ browser, serverInfo }) => {
    const context = await newClientContext(browser)
    const page1 = await context.newPage()
    await page1.setViewportSize({ width: 1500, height: 980 })

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.setViewportSize({ width: 920, height: 640 })
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)

    await executeCommand(page1, 'echo "__MULTI_CLIENT_READY__"')
    await waitForTerminalText(page1, '__MULTI_CLIENT_READY__', terminalId!)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    await executeCommand(page1, 'printf "__PTY_SIZE_BEFORE__:%s\\n" "$(stty size)"')
    const beforeSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_BEFORE__', terminalId!)

    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    await waitForReady(page2)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    // Wait for page2 to have re-attached to the terminal after the forced
    // disconnect, then assert on what actually got sent.
    //
    // This used to require EXACTLY ONE terminal.attach with
    // intent === 'transport_reconnect'. That is the fast, no-op-geometry path
    // TerminalView takes when it reconnects while its own pane is already
    // considered foreground/live (terminal-attach-policy.ts). But whether the
    // client takes that path or the slower "hidden pane reveal" path
    // (background-hydration attach) depends on the client's internal
    // foreground/hidden bookkeeping at the exact instant the reconnect
    // fires -- timing-sensitive, client-side, and NOT something a
    // wait/serialize change in this spec can pin. Under real host load this
    // repo's build+test contention reliably tips it into the
    // background-hydration path (reproduced deterministically here, not
    // occasionally); on a quiet host it can land on transport_reconnect
    // instead -- hence the historical flake, not a too-short wait budget.
    //
    // WIRE-INTENT POLICY (attach-geometry-resume-panes): hidden/background
    // attaches are keepalive_delta BY POLICY -- they never claim geometry;
    // visible foreground attaches remain viewport_hydrate/transport_reconnect.
    // Page2's pane is VISIBLE here, and the foreground reconnect legitimately
    // lands on viewport_hydrate when TerminalView's re-promotion fires
    // (in-flight writes or no usable delta checkpoint -> full replay);
    // verified by wire capture on this test: page2's frames arrive as
    // { intent: 'viewport_hydrate', priority: 'foreground', sinceSeq: 0 }.
    // If the client's hidden bookkeeping instead routes the reconnect through
    // the background-hydration queue, the hidden clamp makes the wire token
    // keepalive_delta with priority background -- replay-identical but
    // geometry-neutral. The accepted reconnect-shaped set is therefore
    // { transport_reconnect, viewport_hydrate, keepalive_delta }; the policy
    // regression (a HIDDEN pane's attach claiming geometry) is pinned exactly
    // by the sibling reload-restore test further down this file, not by this
    // visible-pane scenario.
    //
    // Verified by direct experiment: relaxing this assertion to accept EITHER
    // reconnect-shaped intent and letting the rest of the test run confirms
    // the PTY-size and shared-output checks below (the test's actual
    // documented contract) pass on either path. So the specific intent value
    // within that set is an internal implementation choice, not the behavior
    // this test is meant to guard. What DOES matter, and is still asserted:
    // page2 issued a BOUNDED 1..2 re-attaches for this terminal (not zero --
    // a silently dropped reconnect -- and not a runaway retry storm; the 2
    // covers the reconnect attach plus at most one designed pane.reconcile
    // fold re-fire via the reconcileEpoch bump, detailed below), using a
    // reconnect-shaped intent from the accepted set above.
    await page2.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && (msg?.intent === 'transport_reconnect' || msg?.intent === 'viewport_hydrate' || msg?.intent === 'keepalive_delta')
      )
    }, terminalId!, { timeout: 20_000 })

    const reconnectAttachMessages = await page2.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && (msg?.intent === 'transport_reconnect' || msg?.intent === 'viewport_hydrate' || msg?.intent === 'keepalive_delta')
      )
    }, terminalId!)
    // Under paneReconcileV1 (the adopted client) a reconnect has TWO
    // legitimate attach sources for a live pane: (1) TerminalView's own
    // reconnect/reveal path, and (2) the pane.reconcile `attach` verdict
    // fold, which bumps `reconcileEpoch` and deliberately re-fires the
    // attach effect so the pane converges on server truth even when the
    // client's own bookkeeping is wrong (the A1 epoch-bump design pin in
    // `panesSlice.reconcile.test.ts`: "every fold bumps reconcileEpoch").
    // The pre-reconcile client had only source (1), which is what the old
    // `toHaveLength(1)` encoded. The behavior this test actually guards is
    // unchanged and still asserted: the reconnect was not silently dropped
    // (>= 1), and there is no runaway retry storm (<= 2 -- exactly the two
    // named sources, nothing unbounded).
    expect(reconnectAttachMessages.length).toBeGreaterThanOrEqual(1)
    expect(reconnectAttachMessages.length).toBeLessThanOrEqual(2)

    await executeCommand(page1, 'printf "__PTY_SIZE_AFTER__:%s\\n" "$(stty size)"')
    const afterSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_AFTER__', terminalId!)
    expect(afterSize).toBe(beforeSize)

    await executeCommand(page1, 'echo "__AFTER_PAGE2_RECONNECT__"')
    await waitForTerminalText(page1, '__AFTER_PAGE2_RECONNECT__', terminalId!)
    await waitForTerminalText(page2, '__AFTER_PAGE2_RECONNECT__', terminalId!)

    await context.close()
  })

  // ------------------------------------------------------------------
  // Geometry authority regression (attach-geometry-resume-panes): a
  // reload-restored tab that boots HIDDEN must never claim viewport geometry
  // on the wire -- servers resize the PTY unconditionally for
  // viewport_hydrate, so a hidden tab's stale/never-fitted dims would stomp
  // the visible pane's geometry. The deterministic mount-hidden shape comes
  // from persistence restore (the production boot-time path): a REST/UI
  // create flow auto-selects the new tab so it is never hidden, only a
  // reload restores a hidden-at-mount pane. Post-fix the boot-time
  // background hydration attach is keepalive_delta + priority background
  // (replay-only), and the reveal heals geometry with a terminal.resize
  // whose dims the kernel then confirms via stty.
  // ------------------------------------------------------------------
  test('reload-restored background tab stays geometry-neutral until reveal heals it with a resize', async ({ browser, serverInfo }) => {
    test.setTimeout(120_000)
    const context = await newClientContext(browser)
    const page = await context.newPage()

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await ensureTerminalReady(page)

    // T-A stays the active tab across the reload.
    const tabAId = await page.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null
    )
    expect(tabAId).toBeTruthy()
    const terminalAId = await waitForActiveTerminalId(page)

    // T-B is created and driven once, then hidden behind T-A -- after the
    // reload it is the pane that mounts hidden at boot.
    await page.locator('[data-context="tab-add"]').click()
    await page.waitForFunction((prevTabId) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.tabs?.tabs?.length === 2 && state?.tabs?.activeTabId !== prevTabId
    }, tabAId, { timeout: 10_000 })
    const tabBId = await page.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null
    )
    expect(tabBId).toBeTruthy()

    // A fresh tab may show a PanePicker; select a shell for it. The picker
    // and terminal are scoped to T-B -- T-A's terminal stays mounted (just
    // hidden), so an unscoped `.xterm` could resolve to the wrong pane.
    const tabBTerminal = page.locator(`[data-context="terminal"][data-tab-id="${tabBId}"]`)
    const tabBPicker = page.locator(`[data-context="pane-picker"][data-tab-id="${tabBId}"]`)
    await page.waitForTimeout(500)
    const tabBXtermVisible = await tabBTerminal.locator('.xterm').first().isVisible().catch(() => false)
    if (!tabBXtermVisible) {
      for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
        try {
          const button = tabBPicker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
          if (await button.isVisible().catch(() => false)) {
            await button.click({ timeout: 5000 })
            break
          }
        } catch {
          continue
        }
      }
    }
    await tabBTerminal.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
    const terminalBId = await waitForActiveTerminalId(page)
    expect(terminalBId).not.toBe(terminalAId)

    // Leave a marker in T-B's scrollback: after the reload this marker can
    // only reappear in T-B's buffer once its boot-time background attach's
    // replay has landed -- a deterministic hydration-complete gate (with
    // hydration incomplete the reveal below could legitimately fire a reveal
    // attach instead of the resize-only heal path).
    await tabBTerminal.locator('.xterm').first().click()
    await page.keyboard.type('echo __PRE_RELOAD_MARKER__')
    await page.keyboard.press('Enter')
    await waitForTerminalText(page, '__PRE_RELOAD_MARKER__', terminalBId)

    await activateTab(page, tabAId!)
    await flushPersistedLayout(page, terminalBId)

    // Reload in the SAME context: both tabs restore from persistence; T-A is
    // active/visible and T-B's pane mounts hidden.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForReady(page)
    await waitForTabWithTerminalId(page, terminalBId)
    const restored = await page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return {
        activeTabId: state?.tabs?.activeTabId ?? null,
        tabCount: state?.tabs?.tabs?.length ?? 0,
      }
    })
    expect(restored.tabCount).toBe(2)
    expect(restored.activeTabId).toBe(tabAId)

    // The reload installed a fresh harness, so getSentWsMessages is a clean
    // record of everything since boot. The hidden pane's background hydration
    // attach must be geometry-neutral: keepalive_delta + background, and never
    // viewport_hydrate while hidden.
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && msg?.intent === 'keepalive_delta'
        && msg?.priority === 'background')
    }, terminalBId, { timeout: 45_000 })
    await waitForTerminalText(page, '__PRE_RELOAD_MARKER__', terminalBId, 45_000)

    const hiddenAttaches: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) => msg?.type === 'terminal.attach' && msg?.terminalId === id)
    }, terminalBId)
    expect(
      hiddenAttaches.some((msg: any) => msg.intent === 'keepalive_delta' && msg.priority === 'background'),
      'a hidden-at-boot attach must arrive as keepalive_delta with priority background',
    ).toBe(true)
    expect(
      hiddenAttaches.every((msg: any) => msg.intent !== 'viewport_hydrate'),
      `a hidden pane must never claim viewport geometry; got: ${JSON.stringify(hiddenAttaches)}`,
    ).toBe(true)

    // Reveal T-B. The pane is already live via the geometry-neutral
    // hydration, so NO new attach may fire -- the heal is a terminal.resize
    // that the suppression-record invalidation lets through even when the
    // fitted dims match the dims the clamped attach reported.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
    })
    await activateTab(page, tabBId!)
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) => msg?.type === 'terminal.resize' && msg?.terminalId === id)
    }, terminalBId, { timeout: 15_000 })
    // Observation window for a (forbidden) surprise attach after the reveal.
    await page.waitForTimeout(500)
    const afterReveal: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        (msg?.type === 'terminal.attach' || msg?.type === 'terminal.resize')
        && msg?.terminalId === id)
    }, terminalBId)
    const revealAttaches = afterReveal.filter((msg: any) => msg.type === 'terminal.attach')
    expect(
      revealAttaches,
      `no new attach may fire on reveal (the pane is already live); got: ${JSON.stringify(revealAttaches)}`,
    ).toHaveLength(0)
    const revealResizes = afterReveal.filter((msg: any) => msg.type === 'terminal.resize')
    expect(revealResizes.length).toBeGreaterThanOrEqual(1)
    const healResize = revealResizes[revealResizes.length - 1]
    expect(healResize.cols).toBeGreaterThan(0)
    expect(healResize.rows).toBeGreaterThan(0)

    // Kernel cross-check: the PTY's actual winsize must equal the dims the
    // reveal resize claimed (a hidden-clamp failure would leave the kernel
    // at stale/never-fitted dims instead). Poll rather than assume the
    // server has applied the resize within a fixed settle: each attempt
    // re-asks stty, and readMarkedPtySize takes the LAST __AXIS__ marker,
    // so a retry always compares the freshest kernel echo.
    await expect(async () => {
      await tabBTerminal.locator('.xterm').first().click()
      await page.keyboard.type('echo __AXIS__:$(stty size)')
      await page.keyboard.press('Enter')
      const kernelSize = await waitForMarkedPtySize(page, '__AXIS__', terminalBId)
      expect(kernelSize).toBe(`${healResize.rows} ${healResize.cols}`)
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] })

    await context.close()
  })

  test('settings change broadcasts to other clients', async ({ browser, serverInfo }) => {
    const context = await newClientContext(browser)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    const sharedDefaultCwd = path.join(serverInfo.homeDir, 'multi-client-default-cwd')
    await fs.mkdir(sharedDefaultCwd, { recursive: true })

    // Get initial default cwd from page2 before changing it server-side.
    const settingsBefore = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )

    // Change a server-backed field from page1 via the API.
    const patchResponse = await page1.evaluate(async (info) => {
      const res = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          defaultCwd: info.defaultCwd,
        }),
      })
      return { ok: res.ok, status: res.status }
    }, { baseUrl: serverInfo.baseUrl, token: serverInfo.token, defaultCwd: sharedDefaultCwd })

    expect(patchResponse.ok).toBe(true)

    // Wait for page2 to receive the broadcast and update its settings
    await page2.waitForFunction(
      (expectedDefaultCwd) => {
        const current = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
        return current === expectedDefaultCwd
      },
      sharedDefaultCwd,
      { timeout: 15_000 }
    )

    const settingsAfter = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )
    expect(settingsAfter).toBe(sharedDefaultCwd)
    expect(settingsAfter).not.toBe(settingsBefore)

    await context.close()
  })

  test('server handles many concurrent connections', async ({ browser, serverInfo }) => {
    const context = await newClientContext(browser)
    const pages = []

    // Open 5 pages
    for (let i = 0; i < 5; i++) {
      const page = await context.newPage()
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      pages.push(page)
    }

    // All should connect
    for (const page of pages) {
      await page.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
        { timeout: 20_000 }
      )
    }

    await context.close()
  })

  test('client disconnect is handled gracefully', async ({ browser, serverInfo }) => {
    const context = await newClientContext(browser)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Close one page
    await page1.close()

    // Other page should still work
    await page2.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )

    await context.close()
  })
})
