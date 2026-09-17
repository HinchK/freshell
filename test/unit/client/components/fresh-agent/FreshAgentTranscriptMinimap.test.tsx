import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
