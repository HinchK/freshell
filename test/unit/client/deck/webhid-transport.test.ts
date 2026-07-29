import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

class FakeLibDeck extends EventEmitter {
  PRODUCT_NAME = 'Stream Deck Mini'
  CONTROLS: Array<Record<string, unknown>> = [
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'button', index: i, row: Math.floor(i / 3), column: i % 3, pixelSize: { width: 80, height: 80 },
    })),
  ]
  fillKeyBuffer = vi.fn(async () => {})
  fillLcd = vi.fn(async () => {})
  setBrightness = vi.fn(async () => {})
  clearPanel = vi.fn(async () => {})
  close = vi.fn(async () => {})
}
function plusControls(): Array<Record<string, unknown>> {
  return [
    ...Array.from({ length: 8 }, (_, i) => ({
      type: 'button', index: i, row: Math.floor(i / 4), column: i % 4, pixelSize: { width: 120, height: 120 },
    })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'encoder', index: i, hidIndex: i })),
    { type: 'lcd-segment', id: 0, pixelSize: { width: 800, height: 100 }, drawRegions: true },
  ]
}

// The lib is mocked at the two exports the transport uses. getStreamDecks is
// deliberately NOT exported here — the transport must not import it.
const requestStreamDecks = vi.fn(async (): Promise<FakeLibDeck[]> => [])
const openDevice = vi.fn(async (_dev: unknown): Promise<FakeLibDeck> => new FakeLibDeck())
vi.mock('@elgato-stream-deck/webhid', () => ({
  requestStreamDecks: (...a: never[]) => requestStreamDecks(...a),
  openDevice: (...a: never[]) => openDevice(...a),
}))

import { getGrantedWebHidDeck, requestWebHidDeck, DeckOpenError } from '@/deck/webhid-transport'

// jsdom has no navigator.hid: stub getDevices + disconnect events.
type FakeHidDevice = { vendorId: number; productId: number }
const ELGATO = 0x0fd9
function stubHid(devices: FakeHidDevice[]) {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const hid = {
    getDevices: vi.fn(async () => devices),
    addEventListener: (t: string, cb: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(cb)
    },
    removeEventListener: (t: string, cb: (e: unknown) => void) => listeners.get(t)?.delete(cb),
    fire: (t: string, event: unknown) => listeners.get(t)?.forEach((cb) => cb(event)),
  }
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true })
  return hid
}

beforeEach(() => {
  requestStreamDecks.mockClear()
  openDevice.mockClear()
  openDevice.mockImplementation(async () => new FakeLibDeck())
})
afterEach(() => {
  Reflect.deleteProperty(navigator as object, 'hid')
})

describe('webhid transport', () => {
  it('derives capabilities from CONTROLS', async () => {
    stubHid([]) // wrap() registers the navigator.hid disconnect listener
    requestStreamDecks.mockResolvedValueOnce([new FakeLibDeck()])
    const dev = await requestWebHidDeck()
    expect(dev?.capabilities).toMatchObject({
      model: 'Stream Deck Mini', keyCount: 6, keyRows: 2, keyColumns: 3,
      keyPixelWidth: 80, keyPixelHeight: 80, dialCount: 0, hasTouchStrip: false,
    })
  })

  it('returns null on an empty picker result (user cancel — or Electron, which always resolves [])', async () => {
    expect(await requestWebHidDeck()).toBeNull()
  })

  it('silent reconnect enumerates getDevices() and opens Elgato-vendor devices via the lib openDevice export', async () => {
    const granted: FakeHidDevice = { vendorId: ELGATO, productId: 0x0063 }
    stubHid([{ vendorId: 0x1234, productId: 0x1 }, granted])
    const dev = await getGrantedWebHidDeck()
    expect(dev).not.toBeNull()
    expect(openDevice).toHaveBeenCalledTimes(1)
    expect(openDevice).toHaveBeenCalledWith(granted)
  })

  it('returns null from getGrantedWebHidDeck when no Elgato device is granted', async () => {
    stubHid([{ vendorId: 0x1234, productId: 0x1 }])
    expect(await getGrantedWebHidDeck()).toBeNull()
    expect(openDevice).not.toHaveBeenCalled()
  })

  it('forwards button events, branching on control.type', async () => {
    const lib = new FakeLibDeck()
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    const seen: unknown[] = []
    dev.onInput((e) => seen.push(e))
    lib.emit('down', { type: 'button', index: 4 })
    lib.emit('up', { type: 'button', index: 4 })
    expect(seen).toEqual([{ type: 'keyDown', keyIndex: 4 }, { type: 'keyUp', keyIndex: 4 }])
  })

  it('encoder down does NOT become a keyDown — it becomes a dialPress (indices collide on the Plus)', async () => {
    const lib = new FakeLibDeck()
    lib.PRODUCT_NAME = 'Stream Deck +'
    lib.CONTROLS = plusControls()
    stubHid([{ vendorId: ELGATO, productId: 0x0084 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    expect(dev.capabilities).toMatchObject({ dialCount: 4, hasTouchStrip: true, touchStripPixelWidth: 800, touchStripPixelHeight: 100 })
    const seen: unknown[] = []
    dev.onInput((e) => seen.push(e))
    lib.emit('down', { type: 'encoder', index: 1 })
    lib.emit('up', { type: 'encoder', index: 1 })
    expect(seen).toEqual([{ type: 'dialPress', dialIndex: 1 }])
  })

  it('paints keys via fillKeyBuffer with rgba format and forwards brightness/clear/close', async () => {
    const lib = new FakeLibDeck()
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockResolvedValueOnce(lib)
    const dev = (await getGrantedWebHidDeck())!
    const buf = new Uint8ClampedArray(80 * 80 * 4)
    await dev.setKeyImage(2, buf)
    expect(lib.fillKeyBuffer).toHaveBeenCalledWith(2, expect.anything(), { format: 'rgba' })
    await dev.setBrightness(55)
    expect(lib.setBrightness).toHaveBeenCalledWith(55)
    await dev.clear()
    expect(lib.clearPanel).toHaveBeenCalled()
    await dev.close()
    expect(lib.close).toHaveBeenCalled()
  })

  it('maps a NetworkError DOMException from openDevice to DeckOpenError(in-use)', async () => {
    stubHid([{ vendorId: ELGATO, productId: 0x0063 }])
    openDevice.mockRejectedValueOnce(new DOMException('Failed to open the device.', 'NetworkError'))
    const failure = await getGrantedWebHidDeck().then(() => null, (e: unknown) => e)
    expect(failure).toBeInstanceOf(DeckOpenError)
    expect((failure as DeckOpenError).reason).toBe('in-use')
  })

  it('navigator.hid disconnect for the opened device drives onDisconnect (the lib error event never fires)', async () => {
    const granted: FakeHidDevice = { vendorId: ELGATO, productId: 0x0063 }
    const hid = stubHid([granted])
    const dev = (await getGrantedWebHidDeck())!
    const cb = vi.fn()
    dev.onDisconnect(cb)
    hid.fire('disconnect', { device: { vendorId: 0x9999, productId: 0x1 } }) // some other device
    expect(cb).not.toHaveBeenCalled()
    hid.fire('disconnect', { device: granted })
    hid.fire('disconnect', { device: granted })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
