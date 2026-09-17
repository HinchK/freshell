import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

// Render markdown bodies synchronously — the same LazyMarkdown mock the
// transcript's own suite uses, so assertions never race the Suspense chunk.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

// Canonical geometry for this suite (see transcript-minimap-layout.ts):
//   scrollTop=376, scrollHeight=1000, clientHeight=248
//   railHeight = 248 - 48 (MINIMAP_RAIL_BOTTOM_INSET_PX) = 200, scale = 0.2
//   user-turn content offsets 0 / 300 / 450 -> tick tops 0 / 60 / 90, heights ~10
//   band: height = 248 * 0.2 = 49.6, top = 0.5 * (200 - 49.6) = 75.2
const SCROLL_TOP = 376
const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 248

const TRANSCRIPT = [
  {
    id: 'u1',
    role: 'user' as const,
    summary: 'First user message here',
    items: [{ id: 'i1', kind: 'text' as const, text: 'First user message here' }],
  },
  {
    id: 'a1',
    role: 'assistant' as const,
    summary: 'reply 1',
    items: [{ id: 'i2', kind: 'text' as const, text: 'A'.repeat(200) }],
  },
  {
    id: 'u2',
    role: 'user' as const,
    summary: 'Second user message here',
    items: [{ id: 'i3', kind: 'text' as const, text: 'Second user message here' }],
  },
  {
    id: 'a2',
    role: 'assistant' as const,
    summary: 'reply 2',
    items: [{ id: 'i4', kind: 'text' as const, text: 'B'.repeat(200) }],
  },
  {
    id: 'u3',
    role: 'user' as const,
    summary: 'Third user message here',
    items: [{ id: 'i5', kind: 'text' as const, text: 'Third user message here' }],
  },
  {
    id: 'a3',
    role: 'assistant' as const,
    summary: 'reply 3',
    items: [{ id: 'i6', kind: 'text' as const, text: 'C'.repeat(200) }],
  },
]

function mockScroll(scroller: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  scroller.scrollTop = scrollTop
}

function mockRect(el: Element, top: number, height = 50) {
  el.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

/** Rects consistent with SCROLL_TOP=376: content offsets 0 / 300 / 450. */
function mockUserTurnRects(userTurns: NodeListOf<Element> | Element[]) {
  mockRect(userTurns[0], -376)
  mockRect(userTurns[1], -76)
  mockRect(userTurns[2], 74)
}

function setupScrollableTranscript(turns = TRANSCRIPT) {
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  mockUserTurnRects(userTurns)
  // The minimap's synchronous scroll listener recomputes landmark geometry.
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

/** Dense-cluster geometry: scrollHeight 1000, clientHeight 248 -> railHeight
 *  200, scale 0.2. `count` short user turns bunched at content offsets
 *  500 + i*10 with 10px rects: proportional tops 100 + 2i at the 3px
 *  density floor (max(min(3, 200/count), 10*0.2) = 3 for both counts this
 *  suite uses — min(3, 200/4) and min(3, 200/30) are both 3 — under the
 *  4px clickable floor), packed abutting at a 3px pitch. The clickability
 *  pass joins every consecutive pair (nextTop < prevTop + 4) into ONE
 *  dense multi-member run. Default count 4: tops 100/103/106/109, rail
 *  span 100..112 (last bottom 109+3 minus first top 100). Count 30
 *  (round 3, the bounded-menu fixture): packed tops 100..187 at 3px
 *  pitch, ONE run spanning rail 100..190 whose menu lists 30 items. */
function setupDenseClusterTranscript(count = 4) {
  const turns = Array.from({ length: count }, (_, i) => ({
    id: `du${i}`,
    role: 'user' as const,
    summary: `Dense prompt number ${i + 1}`,
    items: [{ id: `di${i}`, kind: 'text' as const, text: `Dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 1000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, 500 + i * 10, 10))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

/** Evenly-dense isolated-tick geometry (the lone sub-4px tick fixture):
 *  scrollHeight 10000, clientHeight 248 -> railHeight 200, scale 0.02.
 *  Fifty short user turns at content offsets i*200 with 150px rects:
 *  proportional heights 150*0.02 = 3 (effectiveMin min(3, 200/50) = 3),
 *  tops at exact 4px pitch (i*4). The clickability pass joins nothing
 *  (4 < prevTop+4 is false) — 50 dense SINGLETON clusters: every tick is
 *  a lone sub-4px tick, none collides into a multi-member run. */
function setupEvenlyDenseTranscript() {
  const turns = Array.from({ length: 50 }, (_, i) => ({
    id: `eu${i}`,
    role: 'user' as const,
    summary: `Even dense prompt number ${i + 1}`,
    items: [{ id: `ei${i}`, kind: 'text' as const, text: `Even dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 10000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, i * 200, 150))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

const topOf = (el: HTMLElement) => parseFloat(el.style.top)
const heightOf = (el: HTMLElement) => parseFloat(el.style.height)

/** Capturable ResizeObserver stub: records callbacks PER OBSERVED TARGET so
 * tests can fire exactly the callbacks a specific element would receive on a
 * real resize (the global jsdom stub in test/setup/dom.ts is a silent no-op).
 * Target-scoped firing is what makes the article-observation test
 * load-bearing: the scroller observer's callback is never fired there. */
const resizeCallbacksByTarget = new Map<Element, Array<() => void>>()
class CapturingResizeObserver {
  private readonly fire = () => this.cb()
  constructor(private readonly cb: () => void) {}
  observe(el: Element) {
    resizeCallbacksByTarget.set(el, [...(resizeCallbacksByTarget.get(el) ?? []), this.fire])
  }
  unobserve() {}
  disconnect() {}
}

describe('FreshAgentTranscript minimap rail', () => {
  afterEach(() => { vi.unstubAllGlobals(); cleanup() })

  it('renders one tick per user turn, positioned proportionally to transcript length', () => {
    setupScrollableTranscript()

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(3)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
    expect(ticks[1]).toHaveAttribute('aria-label', 'Jump to prompt: Second user message here')
    expect(ticks[2]).toHaveAttribute('aria-label', 'Jump to prompt: Third user message here')
    expect(topOf(ticks[0])).toBeCloseTo(0, 5)
    expect(topOf(ticks[1])).toBeCloseTo(60, 5)
    expect(topOf(ticks[2])).toBeCloseTo(90, 5)
    expect(heightOf(ticks[0])).toBeCloseTo(10, 5)
  })

  it('renders the visible-region band at the proportional scroll position', () => {
    setupScrollableTranscript()

    const band = screen.getByTestId('transcript-minimap-viewport')
    expect(band).toHaveAttribute('aria-hidden', 'true')
    expect(topOf(band)).toBeCloseTo(75.2, 5)
    expect(heightOf(band)).toBeCloseTo(49.6, 5)
  })

  it('moves the visible-region band when the scroller scrolls', () => {
    const { scroller, userTurns } = setupScrollableTranscript()
    expect(topOf(screen.getByTestId('transcript-minimap-viewport'))).toBeCloseTo(75.2, 5)

    // Scroll to the very top; re-mock rects consistently (offsets 0/300/450
    // relative to scrollTop 0).
    mockScroll(scroller, 0, SCROLL_HEIGHT, CLIENT_HEIGHT)
    mockRect(scroller, 0)
    mockRect(userTurns[0], 0)
    mockRect(userTurns[1], 300)
    mockRect(userTurns[2], 450)
    fireEvent.scroll(scroller)

    expect(topOf(screen.getByTestId('transcript-minimap-viewport'))).toBeCloseTo(0, 5)
  })

  it('clicking a tick scrolls that prompt into view', () => {
    const { userTurns } = setupScrollableTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[1].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Jump to prompt: Second user message here' }))

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('previews the prompt in a tooltip on hover and on focus', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Keyboard parity: the tooltip component also opens on focus.
    fireEvent.focus(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.blur(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('truncates long prompts in the aria-label (60) and tooltip (120)', () => {
    const longPrompt = 'A'.repeat(130)
    const turns = [
      { id: 'u1', role: 'user' as const, summary: longPrompt, items: [{ id: 'i1', kind: 'text' as const, text: longPrompt }] },
      { id: 'a1', role: 'assistant' as const, summary: 'reply 1', items: [{ id: 'i2', kind: 'text' as const, text: 'B'.repeat(200) }] },
      { id: 'u2', role: 'user' as const, summary: 'Short second prompt', items: [{ id: 'i3', kind: 'text' as const, text: 'Short second prompt' }] },
    ]
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    mockRect(userTurns[1], 74)
    fireEvent.scroll(scroller)

    const tick = screen.getByRole('button', { name: `Jump to prompt: ${'A'.repeat(59)}…` })
    expect(tick).toHaveAttribute('aria-label', `Jump to prompt: ${'A'.repeat(59)}…`)
    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${'A'.repeat(119)}…`)
  })

  it('wraps long unbroken tokens in the hover preview (break-words)', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    // jsdom cannot observe visual wrapping; this class-presence pin plus the
    // e2e range assertion (transcript-minimap.spec.ts) carry the real behavior.
    expect(screen.getByRole('tooltip')).toHaveClass('break-words')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('recomputes ticks when the transcript grows', () => {
    const utils = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const grown = [
      ...TRANSCRIPT,
      { id: 'u4', role: 'user' as const, summary: 'Fourth user message here', items: [{ id: 'i7', kind: 'text' as const, text: 'Fourth user message here' }] },
      { id: 'a4', role: 'assistant' as const, summary: 'reply 4', items: [{ id: 'i8', kind: 'text' as const, text: 'D'.repeat(200) }] },
    ]
    // NO scroll event and NO extra geometry mocks after the rerender: the
    // transcriptSignature effect alone must re-measure. The new article's
    // real jsdom-zero rect places it at content offset 0 - 0 + scrollTop
    // (376) -> tick top 75.2 (sorted before the Third prompt's 450 -> its
    // tick stays at 90). If the signature recomputation effect were removed,
    // this test fails — nothing else fires.
    utils.rerender(<FreshAgentTranscript turns={grown} />)

    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(4)
    const fourth = screen.getByRole('button', { name: 'Jump to prompt: Fourth user message here' })
    expect(topOf(fourth)).toBeCloseTo(75.2, 5)
  })

  it('hides the rail when the transcript fits the viewport', () => {
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 200, CLIENT_HEIGHT) // scrollHeight 200 <= clientHeight 248
    mockRect(scroller, 0)
    fireEvent.scroll(scroller)

    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('transcript-minimap-viewport')).not.toBeInTheDocument()
  })

  it('hides the rail and its measurement work when showTranscriptMinimap is false', () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} showTranscriptMinimap={false} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockUserTurnRects(userTurns)
    fireEvent.scroll(scroller)

    // The rail is absent under geometry that renders it when the setting is
    // on (this suite's canonical mocks) — the setting, not geometry, hid it.
    expect(screen.queryByRole('group', { name: 'Transcript minimap' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('transcript-minimap-viewport')).not.toBeInTheDocument()
    // "And its work": the unmounted rail registered no ResizeObserver
    // subscriptions (fresh elements cannot have stale entries in the shared
    // per-target callback map).
    for (const el of [scroller, ...Array.from(scroller.children)]) {
      expect(resizeCallbacksByTarget.get(el)).toBeUndefined()
    }
    // The glom chip still works — the shared sweep survives the rail's absence.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
  })

  it('renders a lone tick for a single-prompt transcript (no < 2 gate)', () => {
    const utils = render(<FreshAgentTranscript turns={[TRANSCRIPT[0], TRANSCRIPT[1]]} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    fireEvent.scroll(scroller)

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
    expect(screen.getByTestId('transcript-minimap-viewport')).toBeInTheDocument()
  })

  it('re-measures when an article resizes (disclosure toggle) with no signature change', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const { scroller, userTurns } = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    // An assistant disclosure expands, pushing the second and third user
    // prompts 200px deeper into the content (offsets 500 / 650 -> ticks
    // 100 / 130) — no rerender, no signature change, no scroll.
    mockRect(userTurns[1], 124)
    mockRect(userTurns[2], 274)
    // Fire ONLY the callbacks registered for turn articles — never the
    // scroller observer's — so this test fails if article observation is
    // removed (nothing would fire) instead of passing via the scroller
    // path. act() wraps the callbacks: they setState synchronously.
    await act(async () => {
      for (const el of scroller.querySelectorAll('[data-turn-role]')) {
        for (const fire of resizeCallbacksByTarget.get(el) ?? []) fire()
      }
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(ticks[1])).toBeCloseTo(100, 5)
    expect(topOf(ticks[2])).toBeCloseTo(130, 5)
  })

  it('re-measures when the rolled-back history disclosure resizes', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const rolledBack = [
      { id: 'r1', turnId: 'r1', role: 'user' as const, summary: 'rolled prompt one', items: [{ id: 'r1i', kind: 'text' as const, text: 'rolled prompt one' }], restorable: false },
      { id: 'r2', turnId: 'r2', role: 'user' as const, summary: 'rolled prompt two', items: [{ id: 'r2i', kind: 'text' as const, text: 'rolled prompt two' }], restorable: false },
    ]
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} rolledBackTurns={rolledBack} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockUserTurnRects(userTurns)
    fireEvent.scroll(scroller)
    const section = screen.getByRole('region', { name: 'Rolled back turns' })

    // The disclosure expands outside the turn articles: the live ticks slide
    // deeper. Fire ONLY the section's callbacks — not the articles', not the
    // scroller's — so this test fails unless non-article children are
    // observed.
    mockRect(userTurns[1], 124)
    mockRect(userTurns[2], 274)
    await act(async () => {
      for (const fire of resizeCallbacksByTarget.get(section) ?? []) fire()
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(ticks[1])).toBeCloseTo(100, 5)
    expect(topOf(ticks[2])).toBeCloseTo(130, 5)
  })

  it('re-measures when the scroller itself resizes (pane resize re-scales the rail)', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const { scroller } = setupScrollableTranscript()
    const initialTicks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(initialTicks[1])).toBeCloseTo(60, 5)
    expect(topOf(initialTicks[2])).toBeCloseTo(90, 5)

    // Pane resize: only the scroller's clientHeight grows (248 -> 298). The
    // content is unchanged (scrollHeight 1000, scrollTop 376) and the article
    // rects keep their content offsets (0/300/450) — only the rail geometry
    // changes: railHeight 250, scale 0.25 -> tick tops 0 / 75 / 112.5.
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, 298)
    // Fire ONLY the callbacks registered for the scroller — never the
    // articles' or the disclosure section's — so this test fails if the
    // scroller observation is removed (nothing would fire) instead of
    // passing via another path. act() wraps the callbacks: they setState
    // synchronously.
    await act(async () => {
      for (const fire of resizeCallbacksByTarget.get(scroller) ?? []) fire()
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(ticks[0])).toBeCloseTo(0, 5)
    expect(topOf(ticks[1])).toBeCloseTo(75, 5)
    expect(topOf(ticks[2])).toBeCloseTo(112.5, 5)
  })

  it('opens topmost ticks downward (side bottom) and lower ticks upward (side top)', () => {
    setupScrollableTranscript()
    // railHeight 200 -> top-quarter threshold 50. Tick 0 (top 0) is in the
    // top quarter and must open BELOW its tick; ticks 1 (top 60) and 2
    // (top 90) open above. tooltip.tsx:89-95 sets side "bottom" top =
    // rect.bottom + sideOffset (positive here) and side "top" top =
    // rect.top - height - sideOffset (negative here).
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    fireEvent.mouseEnter(ticks[0])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeGreaterThan(0)
    fireEvent.mouseLeave(ticks[0])
    fireEvent.mouseEnter(ticks[1])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeLessThan(0)
  })

  it('renders no rail under default jsdom geometry (protects the rest of the suite)', () => {
    // No geometry mocks: clientHeight/scrollHeight are 0, so the rail must
    // stay hidden. This is the invariant that keeps every pre-existing
    // transcript test free of minimap buttons.
    render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
  })

  it('runs ONE shared landmark sweep per scroll event, feeding both the glom chip and the rail', () => {
    const { scroller } = setupScrollableTranscript()
    // Both consumers render from the shared sweep: the glom chip names the
    // last prompt above the viewport; the rail shows all three ticks.
    expect(screen.getByRole('button', { name: /Jump to your message/ })).toHaveTextContent('Second user message here')
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const sweepQuery = vi.spyOn(scroller, 'querySelectorAll')
    const scrollerRect = vi.spyOn(scroller, 'getBoundingClientRect')
    fireEvent.scroll(scroller)

    // ONE querySelectorAll('[data-turn-role="user"]') per scroll event — the
    // pre-refactor code ran two (recomputeGlom + the minimap's own sweep).
    const landmarkQueries = sweepQuery.mock.calls.filter(
      ([selector]) => selector === '[data-turn-role="user"]',
    )
    expect(landmarkQueries).toHaveLength(1)
    // One scroller rect read per sweep (shared), not one per consumer.
    expect(scrollerRect).toHaveBeenCalledTimes(1)
    // Both consumers updated from that single sweep.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    sweepQuery.mockRestore()
    scrollerRect.mockRestore()
  })

  it('renders one open-list target over a dense cluster; every per-prompt tick stays in the DOM', () => {
    setupDenseClusterTranscript()

    // The one-tick-per-prompt contract: all four tick buttons remain, fully
    // keyboard/screen-reader accessible as today.
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(4)
    // The dense cluster gains exactly one hit-target button over its span.
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    expect(topOf(clusterTarget)).toBeCloseTo(100, 5)
    expect(heightOf(clusterTarget)).toBeCloseTo(12, 5)
    expect(clusterTarget).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('keeps normal-density clusters on per-tick behavior — no open-list targets', () => {
    setupScrollableTranscript()
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)
  })

  it('opens a ContextMenu listing every prompt in the dense cluster; selecting one jumps to it', () => {
    const { userTurns } = setupDenseClusterTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[2].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-4 — open list' }))

    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Dense prompt number 1')
    expect(items[3]).toHaveTextContent('Dense prompt number 4')

    fireEvent.click(items[2])
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    // ContextMenu closes itself after a selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('gives a lone sub-4px tick a 4px hit target with a 3px painted span and a direct jump (no menu)', () => {
    const { userTurns } = setupEvenlyDenseTranscript()
    const firstTick = screen.getByRole('button', { name: 'Jump to prompt: Even dense prompt number 1' })

    // The button's hit height expands to the 4px clickable floor...
    expect(heightOf(firstTick)).toBeCloseTo(4, 5)
    // ...while the painted line is an inner aria-hidden span at the tick's
    // visual 3px height (same bg classes).
    const painted = firstTick.querySelector('span')
    expect(painted).not.toBeNull()
    expect(painted).toHaveAttribute('aria-hidden', 'true')
    expect(heightOf(painted as HTMLElement)).toBeCloseTo(3, 5)

    // No menu anywhere — the target is unambiguous; clicking jumps directly.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const scrollIntoViewSpy = vi.fn()
    userTurns[0].scrollIntoView = scrollIntoViewSpy
    fireEvent.click(firstTick)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('previews the member prompt under the pointer from the dense cluster target', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    // The target's mocked rect mirrors its rail span (top 100); a pointer Y
    // over member 1's band (rail 103-106 -> clientY 104) previews member 1
    // ('Dense prompt number 2' - member indexes are 0-based).
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 104 })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 2')
  })

  it('updates the cluster preview when the pointer moves to another member band', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 101 }) // member 0 band (100-103)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 1')
    fireEvent.mouseMove(clusterTarget, { clientY: 107 }) // member 2 band (106-109)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 3')
  })

  it('clears the cluster hover preview on mouse leave', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 104 })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 2')
    fireEvent.mouseLeave(clusterTarget)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  // Cluster-opener a11y/focus: the opener is a real <button> in DOM order,
  // so keyboard users reach it natively and Enter/Space drive the same click
  // path as the pointer. The menu primitive moves focus into the menu and
  // never restores it itself (ContextMenu.tsx), so the minimap must. (The
  // primitive's initial rAF item-focus does not run synchronously; these
  // assertions run inside fireEvent's act() - Global Constraints note.)
  it('expands the cluster opener while its menu is open and restores aria-expanded on selection', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(clusterTarget)
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu')

    // Selection closes the menu and flips the opener back to collapsed.
    fireEvent.click(within(menu).getAllByRole('menuitem')[0])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'false')
  })

  it('restores focus to the cluster opener after selecting a menu item', () => {
    const { userTurns } = setupDenseClusterTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[3].scrollIntoView = scrollIntoViewSpy
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })

    fireEvent.click(clusterTarget)
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getAllByRole('menuitem')[3])
    // The selection still jumps...
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // ...and focus lands back on the opener, not stranded on body.
    expect(document.activeElement).toBe(clusterTarget)
  })

  it('closes the cluster menu on Escape and restores focus to the opener', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    fireEvent.click(clusterTarget)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(clusterTarget)
  })

  it('clamps a lone sub-4px tick hit box at the rail bottom (railHeight - top, not 4)', () => {
    // rail 100 (clientHeight 148), scrollHeight 10000 -> scale 0.01;
    // effectiveMin min(3, 100/4) = 3 floors every tick at 3px. Landmarks at
    // content offsets 0/4000/8000/9800 (200px article rects): proportional
    // tops 0/40/80/98, and the packing loop's rail-bottom clamp lifts the
    // last tick to top 97 (railHeight - height); pitches 40/40/17 -> every
    // run is a singleton and every tick is dense (3 < 4): four LONE
    // sub-4px ticks. The last tick's 4px floor would overhang the rail
    // (97 + 4 > 100): its hit box clamps to railHeight - top = 3 exactly,
    // its paint span stays 3px, and its predecessor keeps the full 4px box.
    const turns = Array.from({ length: 4 }, (_, i) => ({
      id: `bu${i}`,
      role: 'user' as const,
      summary: `Bottom prompt number ${i + 1}`,
      items: [{ id: `bi${i}`, kind: 'text' as const, text: `Bottom prompt number ${i + 1}` }],
    }))
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 10000, 148)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    userTurns.forEach((el, i) => mockRect(el, [0, 4000, 8000, 9800][i], 200))
    fireEvent.scroll(scroller)

    // All-lone geometry: no multi-member run anywhere.
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()
    const last = screen.getByRole('button', { name: 'Jump to prompt: Bottom prompt number 4' })
    expect(topOf(last)).toBeCloseTo(97, 5)
    // min(4, 100 - 97): the rail-bottom clamp, pinned exactly.
    expect(heightOf(last)).toBeCloseTo(3, 5)
    const lastPaint = last.querySelector('span')
    expect(lastPaint).not.toBeNull()
    expect(lastPaint).toHaveAttribute('aria-hidden', 'true')
    expect(heightOf(lastPaint as HTMLElement)).toBeCloseTo(3, 5)
    // The predecessor's own hit box is untouched by the edge: full 4px.
    const predecessor = screen.getByRole('button', { name: 'Jump to prompt: Bottom prompt number 3' })
    expect(heightOf(predecessor)).toBeCloseTo(4, 5)
    expect(heightOf(predecessor.querySelector('span') as HTMLElement)).toBeCloseTo(3, 5)
  })

  it('clamps a dense run open-list target at the rail bottom (span ends at the rail edge)', () => {
    // rail 100 (clientHeight 148), scrollHeight 10000 -> scale 0.01. Four
    // landmarks: one at offset 0, three bunched at 9700/9800/9900 (200px
    // rects -> 3px ticks after the effectiveMin floor). The bunched three
    // collide into ONE packed group anchored at the rail-bottom clamp
    // (railHeight - height = 97); the group's packed 9px overflows the 3px
    // span, so the packer scales it to fill 97..100 exactly - members at
    // tops 97/98/99 with 1px heights, ONE dense multi-member run whose
    // span (3px) ends AT the rail bottom. The target's 4px floor would
    // overhang (97 + 4 > 100): min(max(3, 4), 100 - 97) clamps it to 3
    // exactly.
    const turns = Array.from({ length: 4 }, (_, i) => ({
      id: `cu${i}`,
      role: 'user' as const,
      summary: `Clamp prompt number ${i + 1}`,
      items: [{ id: `ci${i}`, kind: 'text' as const, text: `Clamp prompt number ${i + 1}` }],
    }))
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 10000, 148)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    userTurns.forEach((el, i) => mockRect(el, [0, 9700, 9800, 9900][i], 200))
    fireEvent.scroll(scroller)

    const clusterTarget = screen.getByRole('button', { name: 'Prompts 2-4 — open list' })
    expect(topOf(clusterTarget)).toBeCloseTo(97, 5)
    // min(max(3, 4), 100 - 97): the rail-bottom clamp, pinned exactly.
    expect(heightOf(clusterTarget)).toBeCloseTo(3, 5)
  })

  it('clears the open cluster menu when geometry hides the rail, so it cannot reappear stale', () => {
    const { scroller } = setupDenseClusterTranscript()
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-4 — open list' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // Collapse geometry the way the fits-viewport test does (scrollHeight
    // <= clientHeight): the shared sweep yields a null layout and the rail -
    // menu included - unmounts. Without the hygiene effect the menu STATE
    // would survive this.
    mockScroll(scroller, 0, 200, CLIENT_HEIGHT)
    mockRect(scroller, 0)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()

    // Restore scrollable geometry: the rail and its cluster target return,
    // but the STALE menu must not reappear - the hygiene effect cleared it
    // (and its opener element, now detached, with it).
    mockScroll(scroller, 0, 1000, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Prompts 1-4 — open list' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // Round-3 Finding 1 (bounded menu): a dense run can list dozens of
  // prompts; the menu must be a BOUNDED, scrollable surface so it can never
  // overflow the viewport. jsdom cannot compute overflow — these class pins
  // plus the e2e's scrollHeight > clientHeight assertion carry the real
  // bounding behavior.
  it('bounds the cluster menu at 60vh and lists every prompt of a 30-member dense run', () => {
    setupDenseClusterTranscript(30)
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-30 — open list' }))

    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(30)
    // Bounded surface: the instantiation passes max-h + overflow classes
    // through the primitive's new className prop (merged by its cn(...)).
    expect(menu).toHaveClass('max-h-[60vh]')
    expect(menu).toHaveClass('overflow-y-auto')
  })

  it('keeps the keyboard-focused menu item visible in the bounded list (scrollFocusedItemIntoView)', () => {
    setupDenseClusterTranscript(30)
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-30 — open list' }))
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    // jsdom 25 has NO Element.prototype.scrollIntoView (and vi.spyOn refuses
    // absent properties), so install the mock the suite's standard way:
    // per-element vi.fn() assignment (Global Constraints).
    const scrollIntoViewSpy = vi.fn()
    items.forEach((item) => { item.scrollIntoView = scrollIntoViewSpy })
    // Arrow to the last item: every step moves focus; with the flag on,
    // focusItem also scrolls the focused item into view inside the
    // bounded list (the primitive's default stays preventScroll — the
    // focusItem comment).
    for (let i = 0; i < items.length - 1; i++) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
    }
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  // Round-3 Finding 2 (stale snapshot): the open menu's items/position were
  // captured at open; ANY re-measure must close it — a menu that outlives
  // its geometry shows stale prompts and a stale position. This is the
  // geometry-change path, NOT the rail-hidden one: the layout stays
  // non-null and the rail keeps rendering throughout.
  it('closes the open cluster menu when a re-measure replaces the transcript geometry', () => {
    const { scroller } = setupDenseClusterTranscript()
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-4 — open list' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // A streamed prompt grows the transcript: same article rects, new
    // scrollHeight — a NEW measurement object while the layout stays
    // non-null.
    mockScroll(scroller, 0, 1200, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    // Assert immediately after the change event (not just after restore):
    // the menu closed on the re-measure itself, while the rail and its
    // cluster target stayed mounted.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prompts 1-4 — open list' })).toBeInTheDocument()

    // Restoring the geometry does NOT resurrect the closed menu.
    mockScroll(scroller, 0, 1000, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
