// ---------------------------------------------------------------------------
// WebHID transport — DeckDevice implementation wrapping @elgato-stream-deck/webhid
// ---------------------------------------------------------------------------
//
// Entry points:
//   requestWebHidDeck()    — user-gesture picker (null = user cancelled, or
//                            Electron's handler-less requestDevice() -> [])
//   getGrantedWebHidDeck() — silent reconnect via navigator.hid.getDevices()
//
// We deliberately do NOT use the lib's getStreamDecks(): it swallows open
// failures (`.catch(() => null)` + filter) and can never signal "in use".
// openDevice(hidDevice) is the only path where open failures are observable.

import { openDevice, requestStreamDecks } from '@elgato-stream-deck/webhid'
import type { StreamDeckWeb } from '@elgato-stream-deck/webhid'
import { createLogger } from '@/lib/client-logger'
import type { DeckCapabilities, DeckDevice, DeckInputEvent } from './deck-device'

const log = createLogger('StreamDeckWebHid')

const ELGATO_VENDOR_ID = 0x0fd9

export class DeckOpenError extends Error {
  constructor(
    readonly reason: 'in-use' | 'unknown',
    message: string,
  ) {
    super(message)
    this.name = 'DeckOpenError'
  }
}

// An OS-level open failure surfaces as a `NetworkError` DOMException. Match on
// the name only — the message text is unspecified. Note: this same NetworkError
// is what a missing Linux udev rule produces, so callers cannot distinguish
// "in use by another app" from "missing device permissions (Linux udev)".
function toDeckOpenError(error: unknown): DeckOpenError {
  if (error instanceof DOMException && error.name === 'NetworkError') {
    return new DeckOpenError(
      'in-use',
      'Stream Deck could not be opened: in use by another app — or missing device permissions (Linux udev)',
    )
  }
  return new DeckOpenError('unknown', `Stream Deck could not be opened: ${String(error)}`)
}

function deriveCapabilities(lib: StreamDeckWeb): DeckCapabilities {
  let keyCount = 0
  let keyRows = 0
  let keyColumns = 0
  let keyPixelWidth = 0
  let keyPixelHeight = 0
  let dialCount = 0
  let hasTouchStrip = false
  let touchStripPixelWidth = 0
  let touchStripPixelHeight = 0

  for (const control of lib.CONTROLS) {
    if (control.type === 'button') {
      keyCount += 1
      keyRows = Math.max(keyRows, control.row + 1)
      keyColumns = Math.max(keyColumns, control.column + 1)
      if ('pixelSize' in control) {
        keyPixelWidth = Math.max(keyPixelWidth, control.pixelSize.width)
        keyPixelHeight = Math.max(keyPixelHeight, control.pixelSize.height)
      }
    } else if (control.type === 'encoder') {
      dialCount += 1
    } else {
      hasTouchStrip = true
      touchStripPixelWidth = control.pixelSize.width
      touchStripPixelHeight = control.pixelSize.height
    }
  }

  return {
    model: lib.PRODUCT_NAME,
    keyCount,
    keyRows,
    keyColumns,
    keyPixelWidth,
    keyPixelHeight,
    dialCount,
    hasTouchStrip,
    touchStripPixelWidth,
    touchStripPixelHeight,
  }
}

class WebHidDeckDevice implements DeckDevice {
  readonly capabilities: DeckCapabilities

  private readonly inputListeners = new Set<(event: DeckInputEvent) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private disconnectFired = false
  private readonly hidDevice: HIDDevice | undefined

  private readonly onHidDisconnect = (event: unknown): void => {
    const device = (event as { device?: unknown } | undefined)?.device
    if (this.hidDevice && device === this.hidDevice) this.fireDisconnect()
  }

  constructor(
    private readonly lib: StreamDeckWeb,
    hidDevice?: HIDDevice,
  ) {
    // The request path recovers the HIDDevice defensively via untyped-but-stable
    // lib internals; the getGranted path passes the device it opened.
    this.hidDevice =
      hidDevice ?? (lib as unknown as { hid?: { device?: HIDDevice } }).hid?.device
    this.capabilities = deriveCapabilities(lib)

    // Primary disconnect signal: navigator.hid 'disconnect' for our HIDDevice.
    // The lib's 'error' event never fires for Elgato webhid decks (the webhid
    // emit site is commented out) — including on unplug — so nothing relies on it.
    navigator.hid?.addEventListener('disconnect', this.onHidDisconnect)

    // Defensive only: log if it ever fires; never console.error (fatal in tests).
    this.lib.on('error', (error: unknown) => {
      log.warn('device error event', error)
    })

    // down/up fire for BOTH buttons and encoders, and their indices collide
    // (Plus encoders 0-3 vs buttons 0-7) — branching on control.type is mandatory.
    this.lib.on('down', (control) => {
      if (control.type === 'button') {
        this.emitInput({ type: 'keyDown', keyIndex: control.index })
      } else {
        this.emitInput({ type: 'dialPress', dialIndex: control.index })
      }
    })
    this.lib.on('up', (control) => {
      if (control.type === 'button') {
        this.emitInput({ type: 'keyUp', keyIndex: control.index })
      }
      // encoder 'up' is intentionally ignored — dialPress already fired on 'down'
    })

    if (this.capabilities.dialCount > 0) {
      this.lib.on('rotate', (control, amount) => {
        this.emitInput({ type: 'dialRotate', dialIndex: control.index, ticks: amount })
      })
    }
    if (this.capabilities.hasTouchStrip) {
      this.lib.on('lcdShortPress', () => {
        this.emitInput({ type: 'touchTap' })
      })
    }
  }

  async setKeyImage(keyIndex: number, rgba: Uint8ClampedArray): Promise<void> {
    try {
      await this.lib.fillKeyBuffer(keyIndex, rgba, { format: 'rgba' })
    } catch (error) {
      await this.handleWriteFailure('fillKeyBuffer', error)
    }
  }

  async setTouchStripImage(rgba: Uint8ClampedArray, _width: number, _height: number): Promise<void> {
    try {
      await this.lib.fillLcd(0, rgba, { format: 'rgba' })
    } catch (error) {
      await this.handleWriteFailure('fillLcd', error)
    }
  }

  async setBrightness(percent: number): Promise<void> {
    try {
      await this.lib.setBrightness(percent)
    } catch (error) {
      await this.handleWriteFailure('setBrightness', error)
    }
  }

  async clear(): Promise<void> {
    try {
      await this.lib.clearPanel()
    } catch (error) {
      await this.handleWriteFailure('clearPanel', error)
    }
  }

  async close(): Promise<void> {
    navigator.hid?.removeEventListener('disconnect', this.onHidDisconnect)
    await this.lib.close()
  }

  onInput(listener: (event: DeckInputEvent) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  private emitInput(event: DeckInputEvent): void {
    for (const listener of this.inputListeners) listener(event)
  }

  private fireDisconnect(): void {
    if (this.disconnectFired) return
    this.disconnectFired = true
    for (const listener of this.disconnectListeners) listener()
  }

  // Secondary disconnect signal: a rejected write may mean the device is gone
  // (the lib's error event never fires, even on unplug). Callers paint
  // fire-and-forget, so failures are absorbed here, not rethrown.
  private async handleWriteFailure(operation: string, error: unknown): Promise<void> {
    log.warn(`${operation} failed`, error)
    try {
      const devices = await navigator.hid.getDevices()
      if (this.hidDevice && !devices.includes(this.hidDevice)) this.fireDisconnect()
    } catch (probeError) {
      log.warn('getDevices() probe after write failure failed', probeError)
    }
  }
}

function wrap(lib: StreamDeckWeb, hidDevice?: HIDDevice): DeckDevice {
  return new WebHidDeckDevice(lib, hidDevice)
}

// User-gesture entry point. Empty picker result means the user cancelled OR
// the app is Electron (whose handler-less requestDevice() always resolves []):
// both are a clean no-op — never index [0] blindly.
export async function requestWebHidDeck(): Promise<DeckDevice | null> {
  let decks: StreamDeckWeb[]
  try {
    decks = await requestStreamDecks()
  } catch (error) {
    throw toDeckOpenError(error)
  }
  const first = decks[0]
  return first ? wrap(first) : null
}

// Silent reconnect: enumerate granted devices, open the first Elgato one via
// the lib's public openDevice export (the only path where open failures are
// observable). Returns null when no Elgato device is granted.
export async function getGrantedWebHidDeck(): Promise<DeckDevice | null> {
  const devices = await navigator.hid.getDevices()
  const granted = devices.find((device) => device.vendorId === ELGATO_VENDOR_ID)
  if (!granted) return null
  let lib: StreamDeckWeb
  try {
    lib = await openDevice(granted)
  } catch (error) {
    throw toDeckOpenError(error)
  }
  return wrap(lib, granted)
}
