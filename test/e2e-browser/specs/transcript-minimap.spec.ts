import { test, expect } from '../helpers/fixtures.js'

function tallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 60 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
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
})
