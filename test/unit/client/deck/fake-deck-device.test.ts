import { describe, expect, it, vi } from 'vitest'
import { FakeDeckDevice, MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'

describe('FakeDeckDevice', () => {
  it('defaults to the 6-key Mini profile', () => {
    const d = new FakeDeckDevice()
    expect(d.capabilities).toEqual(MINI_CAPS)
  })

  it('records key images, brightness, strip, clear and close', async () => {
    const d = new FakeDeckDevice(PLUS_CAPS)
    const buf = new Uint8ClampedArray(120 * 120 * 4)
    await d.setKeyImage(3, buf)
    expect(d.keyImages.get(3)).toBe(buf)
    await d.setBrightness(40)
    await d.setBrightness(100)
    expect(d.brightnessHistory).toEqual([40, 100])
    const strip = new Uint8ClampedArray(800 * 100 * 4)
    await d.setTouchStripImage(strip, 800, 100)
    expect(d.stripImage).toEqual({ rgba: strip, width: 800, height: 100 })
    await d.clear()
    expect(d.cleared).toBe(true)
    expect(d.keyImages.size).toBe(0)
    await d.close()
    expect(d.closed).toBe(true)
  })

  it('emits input events to listeners and supports unsubscribe', () => {
    const d = new FakeDeckDevice()
    const seen: unknown[] = []
    const off = d.onInput((e) => seen.push(e))
    d.press(2)
    expect(seen).toEqual([
      { type: 'keyDown', keyIndex: 2 },
      { type: 'keyUp', keyIndex: 2 },
    ])
    off()
    d.press(2)
    expect(seen).toHaveLength(2)
  })

  it('notifies disconnect listeners once', () => {
    const d = new FakeDeckDevice()
    const cb = vi.fn()
    d.onDisconnect(cb)
    d.disconnect()
    d.disconnect()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
