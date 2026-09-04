/**
 * MCP/REST FOCUS NEUTRALITY -- e2e proof that agent-surface mutations never
 * steal the user's focus. REST-driven POST /api/tabs and POST
 * /api/panes/:id/split must leave the client's active tab, per-tab active
 * pane, and document.activeElement anchored (splits remount the original
 * pane's DOM by construction, so the SAME PANE reacquires focus — see the
 * section-4 REMOUNT note); the explicit routes
 * POST /api/tabs/:id/select and POST /api/panes/:id/select remain the only
 * agent-surface focus moves.
 *
 * Rust-only: registered in the rust-chromium project only, matching its donor
 * (hidden-pane-rebind-rust.spec.ts) — the helpers boot an owned RustServer on
 * an ephemeral port. Helpers are COPIED from hidden-pane-rebind-rust.spec.ts,
 * not imported, per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'
import os from 'node:os'

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(page: Page): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({})
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

function restApiHeaders(info: TestServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: TestServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

/** Pane id currently holding document.activeElement (null when focus is outside panes). */
async function focusedPaneId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
  )
}

/** Tag the CURRENT document.activeElement with a marker attribute; returns the
 *  marker. Assert exact focus identity (not just "not the new pane") survives
 *  an agent-driven mutation. */
async function tagActiveElement(page: Page): Promise<string> {
  const marker = `focus-marker-${Math.random().toString(36).slice(2)}`
  await page.evaluate((m) => {
    (document.activeElement as HTMLElement | null)?.setAttribute('data-focus-marker', m)
  }, marker)
  return marker
}

async function activeElementStillTagged(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(
    (m) => (document.activeElement as HTMLElement | null)?.getAttribute('data-focus-marker') === m,
    marker,
  )
}

/** Flush the client's mount + scheduled-focus work (layout scheduler is rAF-driven). */
async function flushClientFocusScheduling(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

/** All leaf pane ids under a layout node (split nodes carry no identity of
 *  their own for our purposes — a split keeps the original leaf's id). */
type LayoutNodeShape = { type?: string; id?: string; children?: LayoutNodeShape[] }
function leafIds(node: LayoutNodeShape | undefined): string[] {
  if (!node) return []
  if (node.type !== 'split') return node.id ? [node.id] : []
  return (node.children ?? []).flatMap(leafIds)
}

test.describe('MCP/REST focus neutrality', () => {
  test.setTimeout(120_000)

  test('REST create/split never steal focus; explicit select routes do', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()
      // Readiness gate: selectShellIfPickerShowing returns right after the
      // click, but the picker's onSelect is delayed by its fade transition —
      // tagging activeElement before the terminal mounts would pin the marker
      // to an about-to-unmount picker element. (Donor specs wait for a visible
      // .xterm for the same reason.)
      await expect(page.locator('.xterm:visible').first()).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => (await harness.getPaneLayout(tabA))?.content?.terminalId ?? null, { timeout: 15_000 })
        .not.toBeNull()
      await flushClientFocusScheduling(page)
      const paneA = ((await harness.getState()).panes.layouts[tabA])?.id
      expect(paneA).toBeTruthy()
      // Baseline focus ownership: assert pane A OWNS document focus before
      // tagging — otherwise the identity marker pins whatever happened to be
      // focused (possibly body) and the background-tab sections prove nothing.
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(paneA)
      const marker = await tagActiveElement(page)

      // --- 1: REST tab create does NOT activate (the discriminating assertion:
      // on unfixed code activeTabId flips to the new tab atomically with the
      // fold, and waitForTabCount(2) proves the fold already ran).
      const tabB = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      const stateAfterB = await harness.getState()
      const paneB = stateAfterB.panes.layouts[tabB]?.id
      expect(paneB).toBeTruthy()
      // Wait until the background tab's pane is actually MOUNTED (its mount
      // effects are the only window in which a steal could occur), flush the
      // rAF scheduler, then assert.
      await page.waitForSelector(`[data-pane-id="${paneB}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect(await harness.getActiveTabId()).toBe(tabA)
      expect(await focusedPaneId(page)).not.toBe(paneB)
      expect(await activeElementStillTagged(page, marker)).toBe(true) // exact focus identity preserved

      // --- 2: explicit REST tab.select activates AND moves DOM focus
      // (TerminalView's eligible-focus refocus effect fires on the flip).
      const selRes = await fetch(`${info.baseUrl}/api/tabs/${tabB}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(selRes.ok).toBe(true)
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(paneB)
      const markerB = await tagActiveElement(page) // re-tag: paneB's xterm now holds focus

      // --- 3: another REST create still does not activate nor move DOM focus.
      const tabC = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(3)
      const paneC = ((await harness.getState()).panes.layouts[tabC])?.id
      await page.waitForSelector(`[data-pane-id="${paneC}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect(await harness.getActiveTabId()).toBe(tabB)
      expect(await focusedPaneId(page)).not.toBe(paneC)
      expect(await activeElementStillTagged(page, markerB)).toBe(true)

      // --- 4: REST pane.split does not change tab B's active pane nor DOM focus.
      const originalActivePane = (await harness.getState()).panes.activePane[tabB]
      expect(originalActivePane).toBeTruthy()
      const splitRes = await fetch(`${info.baseUrl}/api/panes/${originalActivePane}/split`, {
        method: 'POST',
        headers: restApiHeaders(info),
        body: JSON.stringify({ direction: 'horizontal', mode: 'shell' }),
      })
      const splitPayload = await splitRes.json()
      expect(splitRes.ok, `POST /api/panes/:id/split: ${JSON.stringify(splitPayload)}`).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.layouts[tabB]?.type, { timeout: 10_000 })
        .toBe('split')
      const newPaneId = (await harness.getState()).panes.layouts[tabB].children[1].id
      await page.waitForSelector(`[data-pane-id="${newPaneId}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect((await harness.getState()).panes.activePane[tabB]).toBe(originalActivePane)
      // REMOUNT note: leaf→split replaces PaneContainer's rendered root (Pane →
      // nested split divs), so the original pane's tagged xterm element is
      // destroyed by construction — markerB cannot survive the split. (Exactly
      // the same remount already happens on USER-driven splits; this change
      // creates no new remount.) The DOM-focus contract for an agent split is:
      // (a) focus never lands in the new pane, and (b) the original active
      // pane reacquires DOM focus through its eligibility refocus effect.
      expect(await focusedPaneId(page)).not.toBe(newPaneId)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(originalActivePane)

      // --- 5: explicit REST pane.select activates the new pane AND moves DOM focus to it.
      const paneSelRes = await fetch(`${info.baseUrl}/api/panes/${newPaneId}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(paneSelRes.ok).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.activePane[tabB], { timeout: 10_000 })
        .toBe(newPaneId)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(newPaneId)
      expect(await harness.getActiveTabId()).toBe(tabB)

      // --- 6: split while the user's focus is in APP CHROME must not yank it
      // back into the remounted pane. Redux focusEligible (tab active + pane
      // active) is TRUE for the remounted pane, so only the pre-unmount focus-
      // ownership record distinguishes this from section 4 (where the pane
      // owned focus and legitimately reacquires it). Focus the TabBar's "New
      // shell tab" button programmatically (no click — zero side effects).
      await page.locator('button[aria-label="New shell tab"]').first().evaluate((el) => (el as HTMLElement).focus())
      const chromeMarker = await tagActiveElement(page)
      expect(await focusedPaneId(page)).toBeNull() // chrome is outside every pane
      const leavesBefore6 = leafIds((await harness.getState()).panes.layouts[tabB])
      const splitRes6 = await fetch(`${info.baseUrl}/api/panes/${newPaneId}/split`, {
        method: 'POST',
        headers: restApiHeaders(info),
        body: JSON.stringify({ direction: 'horizontal', mode: 'shell' }),
      })
      expect(splitRes6.ok).toBe(true)
      await expect
        .poll(async () => leafIds((await harness.getState()).panes.layouts[tabB]).length, { timeout: 10_000 })
        .toBe(leavesBefore6.length + 1)
      await flushClientFocusScheduling(page)
      expect((await harness.getState()).panes.activePane[tabB]).toBe(newPaneId)
      // The remounted pane must NOT reacquire focus; the chrome button keeps it.
      expect(await activeElementStillTagged(page, chromeMarker)).toBe(true)
      expect(await focusedPaneId(page)).toBeNull()

      // --- 7: a BACKGROUND (focus-ineligible, therefore inert + locked)
      // browser pane whose nested page focuses itself must not steal focus.
      // inert alone does NOT stop a script inside the nested document from
      // hoisting the iframe into document.activeElement (Chromium-verified);
      // the data-focus-locked rebuff guard restores the displaced element.
      // The payload is a same-origin-less data: page (the hoist needs no
      // origin relationship), so this works fully offline.
      const payloadUrl = `data:text/html,${encodeURIComponent(
        '<input id=x autofocus><script>setTimeout(()=>document.getElementById("x").focus(),100)</script>',
      )}`
      const leavesBefore7 = leafIds((await harness.getState()).panes.layouts[tabB])
      const splitRes7 = await fetch(`${info.baseUrl}/api/panes/${newPaneId}/split`, {
        method: 'POST',
        headers: restApiHeaders(info),
        body: JSON.stringify({ direction: 'vertical', browser: payloadUrl }),
      })
      const split7Payload = await splitRes7.json()
      expect(splitRes7.ok, `POST /api/panes/:id/split browser: ${JSON.stringify(split7Payload)}`).toBe(true)
      // Derive the new leaf from the folded layout (same convention as §4) —
      // the split keeps the original leaf's id and appends one new leaf.
      let browserPaneId: string | null = null
      await expect
        .poll(async () => {
          browserPaneId = leafIds((await harness.getState()).panes.layouts[tabB])
            .find((id) => !leavesBefore7.includes(id)) ?? null
          return browserPaneId
        }, { timeout: 10_000 })
        .not.toBeNull()
      await page.waitForSelector(`[data-pane-id="${browserPaneId}"] iframe`, { state: 'attached', timeout: 15_000 })
      const browserIframe = page.locator(`[data-pane-id="${browserPaneId}"] iframe`).first()
      // Ineligible => inert AND locked (live-attribute pin).
      await expect(browserIframe).toHaveAttribute('inert', '', { timeout: 10_000 })
      await expect(browserIframe).toHaveAttribute('data-focus-locked', 'true')
      // Wait out the payload's focus attempt window (autofocus on load +
      // scripted focus at ~100ms), then assert focus never stuck inside the
      // background browser pane and the chrome element kept it.
      await page.waitForTimeout(1_500)
      await flushClientFocusScheduling(page)
      expect(await activeElementStillTagged(page, chromeMarker)).toBe(true)
      expect(await focusedPaneId(page)).not.toBe(browserPaneId)

      // --- 8 (control): explicitly selecting the browser pane removes inert
      // (attribute flip, no iframe reload) and returns DOM focus to its pane.
      const paneSelRes8 = await fetch(`${info.baseUrl}/api/panes/${browserPaneId}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(paneSelRes8.ok).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.activePane[tabB], { timeout: 10_000 })
        .toBe(browserPaneId)
      await expect(browserIframe).not.toHaveAttribute('inert', '', { timeout: 10_000 })
      await expect(browserIframe).not.toHaveAttribute('data-focus-locked', 'true')
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(browserPaneId)
    } finally {
      await server.stop()
    }
  })
})
