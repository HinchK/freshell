import { describe, expect, it } from 'vitest'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import {
  deriveGlomTarget,
  measureTranscriptUserTurns,
  type TranscriptMeasurement,
} from '@/components/fresh-agent/shared/transcript-measurement'

function userTurn(id: string, text: string): FreshAgentTurn {
  return {
    id,
    role: 'user',
    summary: text,
    items: [{ id: `${id}-item`, kind: 'text', text }],
  }
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

function buildScroller(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  scroller.scrollTop = scrollTop
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  return scroller
}

function addUserArticle(scroller: HTMLDivElement, index: number | string | null) {
  const el = document.createElement('article')
  el.setAttribute('data-turn-role', 'user')
  if (index !== null) el.setAttribute('data-turn-index', String(index))
  scroller.appendChild(el)
  return el
}

describe('measureTranscriptUserTurns', () => {
  it('returns null for a missing scroller', () => {
    expect(measureTranscriptUserTurns(null, [])).toBeNull()
  })

  it('collects one landmark per valid user article in document order, applying the shared skip rules', () => {
    const scroller = buildScroller(100, 2000, 300)
    const ok0 = addUserArticle(scroller, 0)
    addUserArticle(scroller, null)            // missing data-turn-index -> skipped
    addUserArticle(scroller, 'not-a-number')  // NaN index -> skipped
    addUserArticle(scroller, 7)               // no displayTurns[7] -> skipped
    const ok1 = addUserArticle(scroller, 1)
    const ok2 = addUserArticle(scroller, 2)    // empty label -> skipped
    mockRect(scroller, 500)
    mockRect(ok0, 400) // offsetTop = 400 - 500 + 100 = 0
    mockRect(ok1, 700) // offsetTop = 700 - 500 + 100 = 300
    mockRect(ok2, 900)

    const turns = [userTurn('u0', 'First prompt'), userTurn('u1', 'Second prompt'), userTurn('u2', '')]
    const measurement = measureTranscriptUserTurns(scroller, turns)

    expect(measurement).toEqual({
      landmarks: [
        { index: 0, offsetTop: 0, height: 50, label: 'First prompt' },
        { index: 1, offsetTop: 300, height: 50, label: 'Second prompt' },
      ],
      scrollHeight: 2000,
      clientHeight: 300,
      scrollTop: 100,
    })
  })
})

describe('deriveGlomTarget', () => {
  it('returns null for a null measurement or no landmarks', () => {
    expect(deriveGlomTarget(null)).toBeNull()
    const empty: TranscriptMeasurement = { landmarks: [], scrollHeight: 1000, clientHeight: 200, scrollTop: 400 }
    expect(deriveGlomTarget(empty)).toBeNull()
  })

  it('derives the LAST user turn above the viewport top', () => {
    // Landmarks are document order; the glom chip keeps overwriting its
    // target so the last above-viewport turn wins (the pre-refactor behavior).
    const measurement: TranscriptMeasurement = {
      landmarks: [
        { index: 0, offsetTop: 0, height: 100, label: 'First prompt' },
        { index: 2, offsetTop: 300, height: 100, label: 'Second prompt' },
        { index: 4, offsetTop: 450, height: 100, label: 'Third prompt' },
      ],
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 400,
    }
    expect(deriveGlomTarget(measurement)).toEqual({ index: 2, text: 'Second prompt' })
  })

  it('treats a turn exactly at the viewport top as NOT above it (strict <)', () => {
    const measurement: TranscriptMeasurement = {
      landmarks: [{ index: 1, offsetTop: 400, height: 100, label: 'At the top' }],
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 400,
    }
    expect(deriveGlomTarget(measurement)).toBeNull()
  })
})
