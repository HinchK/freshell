import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerTerminalCaptureHandler, suspendTerminalRenderersForScreenshot } from '@/lib/screenshot-capture-env'

describe('suspendTerminalRenderersForScreenshot refcounting', () => {
  let events: string[] = []
  let detach: () => void

  beforeEach(() => {
    events = []
    detach?.()
    detach = () => {}
  })

  it('overlapping suspensions resume the renderers only when the LAST one lands', async () => {
    detach = registerTerminalCaptureHandler('pane-1', {
      suspendWebgl: () => { events.push('suspend'); return true },
      resumeWebgl: () => { events.push('resume') },
    })

    const resumeA = await suspendTerminalRenderersForScreenshot()
    const resumeB = await suspendTerminalRenderersForScreenshot()

    expect(events).toEqual(['suspend']) // the second suspension extends, never re-suspends

    await resumeB() // out-of-order resume: depth still held by A
    expect(events).toEqual(['suspend'])

    await resumeA() // final release
    expect(events).toEqual(['suspend', 'resume'])
    detach()
  })

  it('a resumer is idempotent (end-of-capture AND abandon fence can both invoke it)', async () => {
    detach = registerTerminalCaptureHandler('pane-1', {
      suspendWebgl: () => { events.push('suspend'); return true },
      resumeWebgl: () => { events.push('resume') },
    })

    const resume = await suspendTerminalRenderersForScreenshot()
    await resume()
    await resume()
    expect(events).toEqual(['suspend', 'resume'])
    detach()
  })

  it('a fresh suspension after full release resumes cleanly', async () => {
    detach = registerTerminalCaptureHandler('pane-1', {
      suspendWebgl: () => { events.push('suspend'); return true },
      resumeWebgl: () => { events.push('resume') },
    })

    const resumeOne = await suspendTerminalRenderersForScreenshot()
    await resumeOne()
    const resumeTwo = await suspendTerminalRenderersForScreenshot()
    await resumeTwo()
    expect(events).toEqual(['suspend', 'resume', 'suspend', 'resume'])
    detach()
  })
})
