import { test, expect } from '../helpers/fixtures.js'

function tallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 60 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
  ).join('\n\n')
}

function veryTallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 240 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog, and then it jumps again.`,
  ).join('\n\n')
}

/** One 200-char unbreakable token: no spaces AND no line-break opportunities
 * (no hyphens, slashes, or punctuation — CSS creates break opportunities at
 * those even without overflow-wrap, which load-bearing validation proved
 * empirically in headless Chromium), so only overflow-wrap can keep it
 * inside the 16rem tooltip box. */
const LONG_UNBROKEN_TOKEN = 'B'.repeat(200)

/** Convert the active terminal leaf into a freshclaude pane whose routed
 * thread snapshot carries the given turns. Mirrors installFreshclaudeStripPane
 * (fresh-agent.spec.ts): network effects suppressed BEFORE the conversion so
 * the pane never WS-connects to a sidecar; the REST snapshot is the only
 * fetch. No provider binary involved, so the spec is cloud-legal. */
async function seedMinimapPane(page: any, sessionId: string, turns: unknown[]) {
  await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshclaude',
        provider: 'claude',
        threadId: sessionId,
        sessionId,
        revision: 1,
        latestTurnId: (turns[turns.length - 1] as { id?: string } | undefined)?.id ?? null,
        status: 'idle',
        summary: '',
        capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
        settings: { model: 'opus[1m]', permissionMode: 'default', plugins: [] },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        turns,
        extensions: { claude: { liveSessionId: sessionId, cliSessionId: sessionId } },
      }),
    })
  })
  await page.evaluate((currentSessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (!tabId || !paneId) return
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: `req-minimap-${currentSessionId}`,
          sessionId: currentSessionId,
          sessionRef: { provider: 'claude', sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, sessionId)
}

test.describe('Transcript minimap', () => {
  test('shows one tick per user prompt with hover preview, and clicking a tick jumps to that turn', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa101'
    await seedMinimapPane(page, sessionId, [
      { id: 'turn-mm-u1', turnId: 'turn-mm-u1', role: 'user', summary: LONG_UNBROKEN_TOKEN, items: [{ id: 'item-mm-u1', kind: 'text', text: LONG_UNBROKEN_TOKEN }] },
      { id: 'turn-mm-a1', turnId: 'turn-mm-a1', role: 'assistant', summary: 'Notes body', items: [{ id: 'item-mm-a1', kind: 'text', text: tallBody('Notes') }] },
      { id: 'turn-mm-u2', turnId: 'turn-mm-u2', role: 'user', summary: 'Now add the upgrade guide', items: [{ id: 'item-mm-u2', kind: 'text', text: 'Now add the upgrade guide' }] },
      { id: 'turn-mm-a2', turnId: 'turn-mm-a2', role: 'assistant', summary: 'Guide body', items: [{ id: 'item-mm-a2', kind: 'text', text: tallBody('Guide') }] },
      { id: 'turn-mm-u3', turnId: 'turn-mm-u3', role: 'user', summary: 'Finally, summarize the risks', items: [{ id: 'item-mm-u3', kind: 'text', text: 'Finally, summarize the risks' }] },
      { id: 'turn-mm-a3', turnId: 'turn-mm-a3', role: 'assistant', summary: 'Risks body', items: [{ id: 'item-mm-a3', kind: 'text', text: tallBody('Risks') }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    // One tick per user-prompt turn; the visible-region band renders.
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(3)
    await expect(freshPane.getByTestId('transcript-minimap-viewport')).toBeVisible()

    // Hover preview: the existing tooltip component portals role="tooltip" to
    // document.body. The middle tick sits mid-rail, clear of the glom chip's
    // top band (which spans the full width at z-20 when visible).
    const middle = freshPane.getByRole('button', { name: 'Jump to prompt: Now add the upgrade guide', exact: true })
    await middle.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Now add the upgrade guide')
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    // Word-break: hovering the unbreakable-token prompt must keep the rendered
    // text inside the tooltip box (break-words). Without overflow-wrap the
    // 120-char truncated token paints as one ~840px line spilling past the
    // 16rem box (verified: a plain-alphanumeric token has no CSS break
    // opportunities, so it genuinely cannot wrap without overflow-wrap).
    const first = freshPane.getByRole('button', { name: /^Jump to prompt: B/ })
    await first.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    const textFitsBox = await tooltip.evaluate((el: HTMLElement) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1
    })
    expect(textFitsBox).toBe(true)
    await page.mouse.move(0, 0)
    await expect(tooltip).toHaveCount(0)

    // Click-to-jump: the transcript loads pinned to the bottom (atBottom
    // layout effect), so jumping to the second prompt moves scrollTop up and
    // lands the turn at the scrollport top (block: 'start').
    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    expect(before).toBeGreaterThan(0)
    await middle.click()
    await expect.poll(
      async () => scroller.evaluate((el: HTMLElement) => el.scrollTop),
      { timeout: 5_000 },
    ).toBeLessThan(before)
    const scrollerTop = await scroller.evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    const targetTop = await freshPane.locator('article[data-turn-role="user"]').nth(1)
      .evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    expect(Math.abs(targetTop - scrollerTop)).toBeLessThan(60)
  })

  test('hides the minimap when the transcript fits the viewport', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa102'
    // Two short user prompts: both prompts exist (so a 0-tick result cannot
    // mean they were missing), and the seeded content is short — the
    // content-fits-viewport gate is the only hide condition in play.
    await seedMinimapPane(page, sessionId, [
      { id: 'turn-mm2-u1', turnId: 'turn-mm2-u1', role: 'user', summary: 'Hello there', items: [{ id: 'item-mm2-u1', kind: 'text', text: 'Hello there' }] },
      { id: 'turn-mm2-a1', turnId: 'turn-mm2-a1', role: 'assistant', summary: 'Hi', items: [{ id: 'item-mm2-a1', kind: 'text', text: 'Hi!' }] },
      { id: 'turn-mm2-u2', turnId: 'turn-mm2-u2', role: 'user', summary: 'One more thing', items: [{ id: 'item-mm2-u2', kind: 'text', text: 'One more thing' }] },
      { id: 'turn-mm2-a2', turnId: 'turn-mm2-a2', role: 'assistant', summary: 'Sure', items: [{ id: 'item-mm2-a2', kind: 'text', text: 'Sure.' }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane.getByText('One more thing', { exact: true })).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    // Self-verifying precondition: this test's guarantee depends on the
    // seeded content actually fitting the pane viewport. If this assertion
    // fails on the cloud pane geometry, shorten the assistant bodies until
    // it passes — do not delete the guard.
    const fits = await scroller.evaluate((el: HTMLElement) => el.scrollHeight <= el.clientHeight)
    expect(fits).toBe(true)
    await expect(freshPane.getByRole('button', { name: /Jump to prompt:/ })).toHaveCount(0)
  })

  test('dense prompt clusters get one open-list target whose menu jumps to any prompt', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa103'
    const turns: unknown[] = []
    for (let i = 0; i < 4; i++) {
      turns.push({
        id: `turn-dense-a${i}`, turnId: `turn-dense-a${i}`, role: 'assistant', summary: `Body ${i}`,
        items: [{ id: `item-dense-a${i}`, kind: 'text', text: veryTallBody(`Body${i}`) }],
      })
    }
    // Round 3 scales the bunched seed from 12 to 40 prompts: at this
    // density the whole bunch joins into ONE dense cluster whose 40-item
    // menu genuinely overflows the bounded 60vh surface (a 12-item menu
    // never overflows, so "every prompt is reachable in the bounded list"
    // was unproven). Keep the prompts consecutive one-liners — tiny
    // offsets, one bunched cluster, exactly as the 12-prompt seed did.
    for (let i = 0; i < 40; i++) {
      turns.push({
        id: `turn-dense-u${i}`, turnId: `turn-dense-u${i}`, role: 'user', summary: `Dense prompt ${i + 1}`,
        items: [{ id: `item-dense-u${i}`, kind: 'text', text: `Dense prompt ${i + 1}` }],
      })
    }
    // Trailing tall assistant body (round 3): the FINAL bunched prompt must
    // sit far above the pinned-to-bottom scroll position — without trailing
    // content the last prompt lands inside the initial bottom viewport and
    // jumping to it clamps to a no-op scroll, so the final-item jump below
    // would prove nothing.
    turns.push({
      id: 'turn-dense-a-tail', turnId: 'turn-dense-a-tail', role: 'assistant', summary: 'Tail body',
      items: [{ id: 'item-dense-a-tail', kind: 'text', text: veryTallBody('Tail') }],
    })
    await seedMinimapPane(page, sessionId, turns)

    const freshPane = page.locator('[data-context="fresh-agent"]')
    // The load pins to the bottom, and the trailing tail body now ENDS the
    // content — the initially visible text is the tail body's last line,
    // not the final bunched prompt (prompt 40 sits a full tall body above
    // the bottom). Wait on the tail line; the tick-count assertion below
    // proves the prompts rendered.
    await expect(freshPane.getByText('Tail line 240', { exact: false })).toBeVisible({ timeout: 20_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible()

    // Every prompt keeps its tick (one-tick-per-prompt contract).
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(40)

    // Self-verifying density guard: the first prompt tick must be under the
    // 4px clickable floor in THIS pane geometry — otherwise the cluster
    // affordance is not in play and the test proves nothing. If this fails
    // on cloud geometry, grow veryTallBody's paragraph count — do not
    // delete the guard.
    const firstTickHeight = await ticks.first().evaluate((el: HTMLElement) => el.getBoundingClientRect().height)
    expect(firstTickHeight).toBeLessThan(4)

    // One open-list target covers the bunched cluster — EXACTLY one: the
    // whole 40-prompt bunch must join into a single dense run. Clicking it
    // opens a menu listing every prompt in the run.
    const clusterTargets = freshPane.getByRole('button', { name: /— open list/ })
    await expect(clusterTargets).toHaveCount(1)
    await clusterTargets.first().click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const itemCount = await page.getByRole('menuitem').count()
    expect(itemCount).toBe(40)

    // The menu is BOUNDED and genuinely overflows in a real browser:
    // max-h-[60vh] caps the list's box below its 40-item content.
    const menuOverflows = await menu.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight)
    expect(menuOverflows).toBe(true)

    // Selecting the FINAL menu item is the load-bearing choice: in an
    // UNBOUNDED menu every item is trivially reachable (the list just runs
    // past the viewport); only in THIS bounded menu does the last item sit
    // below the fold — Playwright's click must scroll the menu's own list
    // to reach it, exactly what a pointer user does by hand.
    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    await page.getByRole('menuitem').last().click()
    await expect(menu).toHaveCount(0)
    // The transcript jumped to the final bunched prompt: scrollTop drops
    // (the load starts pinned to the bottom; the trailing tail body keeps
    // prompt 40 far above it) and the prompt lands at the scrollport top
    // (block: 'start') — the same landing assertion as the tick-click jump
    // in test 1.
    await expect.poll(
      async () => scroller.evaluate((el: HTMLElement) => el.scrollTop),
      { timeout: 5_000 },
    ).toBeLessThan(before)
    const scrollerTop = await scroller.evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    const targetTop = await freshPane.locator('article[data-turn-role="user"]').last()
      .evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    expect(Math.abs(targetTop - scrollerTop)).toBeLessThan(60)
    // The ticks never went anywhere.
    await expect(ticks).toHaveCount(40)
  })
})
