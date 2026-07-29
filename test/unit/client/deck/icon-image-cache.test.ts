import { describe, it, expect, vi } from 'vitest'
import { IconImageCache, getIconImageCache, resetIconImageCacheForTests, hasDrawnPixels } from '@/deck/icon-image-cache'

const fakeBitmap = { width: 16, height: 16 } as unknown as CanvasImageSource

function deferredLoader() {
  // NOTE: `pending` is a Map keyed by url, so a duplicate load for the same url would
  // overwrite the same key and `pending.size` could never detect it. `calls()` counts
  // actual loader invocations - that is the ONLY signal that can catch duplicate loads
  // or a retry-after-failure implementation.
  const pending = new Map<string, { resolve: (b: CanvasImageSource) => void; reject: (e: Error) => void }>()
  let loads = 0
  const loader = (url: string) => {
    loads++
    return new Promise<CanvasImageSource>((resolve, reject) => pending.set(url, { resolve, reject }))
  }
  return { loader, pending, calls: () => loads }
}

describe('IconImageCache', () => {
  it('returns null while loading, kicks off exactly one load per url, notifies on completion', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)
    expect(cache.bitmapFor('/i/a')).toBe(null)
    expect(cache.bitmapFor('/i/a')).toBe(null) // second call: no second load
    expect(calls()).toBe(1) // loader invoked exactly once (pending.size can't see dupes)
    pending.get('/i/a')!.resolve(fakeBitmap)
    await Promise.resolve() // flush microtasks
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/a')).toBe(fakeBitmap)
  })

  it('caches failures permanently (null forever, no retry) and still notifies', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)
    cache.bitmapFor('/i/broken')
    pending.get('/i/broken')!.reject(new Error('404'))
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/broken')).toBe(null)
    expect(cache.bitmapFor('/i/broken')).toBe(null)
    // The load-bearing no-retry assertion: post-failure reads never re-invoke the loader.
    // (A retrying implementation would re-kick the load on every bitmapFor -> fetch/repaint
    // loop in production; pending.size stays 1 either way, so it proves nothing.)
    expect(calls()).toBe(1)
  })

  it('drawn-empty probe failing records the entry as FAILED (letter avatar renders), no retry', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader, () => false) // injected probe: "drew ~0 pixels"
    const listener = vi.fn()
    cache.subscribe(listener)
    cache.bitmapFor('/i/blank-svg')
    pending.get('/i/blank-svg')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/blank-svg')).toBe(null) // failed, like a load error
    expect(calls()).toBe(1) // permanent: the post-failure read above did not re-invoke the loader
  })

  it('drawn-empty probe passing keeps the bitmap', async () => {
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader, () => true)
    cache.bitmapFor('/i/ok')
    pending.get('/i/ok')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.bitmapFor('/i/ok')).toBe(fakeBitmap)
  })

  it('unsubscribe stops notifications', async () => {
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)()
    cache.bitmapFor('/i/a')
    pending.get('/i/a')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it('singleton: getIconImageCache returns the same instance; reset swaps it for tests', () => {
    resetIconImageCacheForTests()
    const a = getIconImageCache()
    expect(getIconImageCache()).toBe(a)
    const fake = new IconImageCache(async () => fakeBitmap)
    resetIconImageCacheForTests(fake)
    expect(getIconImageCache()).toBe(fake)
    resetIconImageCacheForTests()
  })
})

describe('hasDrawnPixels (drawn-empty threshold)', () => {
  const px = (alphas: number[]): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(alphas.length * 4)
    alphas.forEach((a, i) => { data[i * 4 + 3] = a })
    return data
  }
  it('false for a fully transparent draw', () => {
    expect(hasDrawnPixels(px(new Array(100).fill(0)))).toBe(false)
  })
  it('true at >= 1% alpha coverage', () => {
    expect(hasDrawnPixels(px([255, ...new Array(99).fill(0)]))).toBe(true) // exactly 1%
  })
  it('false just below 1% coverage', () => {
    expect(hasDrawnPixels(px([255, ...new Array(199).fill(0)]))).toBe(false) // 0.5%
  })
})
