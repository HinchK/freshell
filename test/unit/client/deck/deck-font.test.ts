import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECK_FONT_FAMILY, DECK_FONT_STACK, whenDeckFontReady } from '@/deck/deck-font'

// jsdom has no document.fonts; tests that need one install a mock and restore it.
afterEach(() => {
  delete (document as unknown as { fonts?: unknown }).fonts
})

function installFontsMock() {
  const load = vi.fn().mockResolvedValue([])
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
  return { load }
}

describe('deck-font', () => {
  it('exposes the Inter family with a sans-serif fallback', () => {
    expect(DECK_FONT_FAMILY).toBe('Inter')
    expect(DECK_FONT_STACK).toBe('Inter, sans-serif')
  })

  it('is a silent no-op without document.fonts (jsdom): never calls onReady, never throws', async () => {
    const onReady = vi.fn()
    const cancel = whenDeckFontReady(onReady)
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()
    expect(cancel).not.toThrow()
  })

  it('loads weights 400 and 600 then calls onReady once', async () => {
    const { load } = installFontsMock()
    const onReady = vi.fn()
    whenDeckFontReady(onReady)
    expect(load).toHaveBeenCalledWith('400 16px "Inter"')
    expect(load).toHaveBeenCalledWith('600 16px "Inter"')
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  })

  it('cancel prevents a late load from calling onReady', async () => {
    installFontsMock()
    const onReady = vi.fn()
    const cancel = whenDeckFontReady(onReady)
    cancel()
    await new Promise((r) => setTimeout(r, 0))
    expect(onReady).not.toHaveBeenCalled()
  })

  it('a failed load stays silent (fallback font keeps working)', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no font'))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
    const onReady = vi.fn()
    whenDeckFontReady(onReady) // must not throw / unhandled-reject / console.error
    await new Promise((r) => setTimeout(r, 0))
    expect(onReady).not.toHaveBeenCalled()
  })
})
