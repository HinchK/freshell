import type { DeckCapabilities, DeckDevice, DeckInputEvent } from './deck-device'

export const MINI_CAPS: DeckCapabilities = {
  model: 'Fake Mini', keyCount: 6, keyRows: 2, keyColumns: 3,
  keyPixelWidth: 80, keyPixelHeight: 80,
  dialCount: 0, hasTouchStrip: false, touchStripPixelWidth: 0, touchStripPixelHeight: 0,
}

export const PLUS_CAPS: DeckCapabilities = {
  model: 'Fake Plus', keyCount: 8, keyRows: 2, keyColumns: 4,
  keyPixelWidth: 120, keyPixelHeight: 120,
  dialCount: 4, hasTouchStrip: true, touchStripPixelWidth: 800, touchStripPixelHeight: 100,
}

export class FakeDeckDevice implements DeckDevice {
  readonly capabilities: DeckCapabilities
  keyImages = new Map<number, Uint8ClampedArray>()
  stripImage: { rgba: Uint8ClampedArray; width: number; height: number } | null = null
  brightnessHistory: number[] = []
  closed = false
  cleared = false
  private inputListeners = new Set<(e: DeckInputEvent) => void>()
  private disconnectListeners = new Set<() => void>()
  private disconnected = false

  constructor(caps?: Partial<DeckCapabilities>) {
    this.capabilities = { ...MINI_CAPS, ...caps }
  }

  async setKeyImage(keyIndex: number, rgba: Uint8ClampedArray): Promise<void> {
    this.keyImages.set(keyIndex, rgba)
  }

  async setTouchStripImage(rgba: Uint8ClampedArray, width: number, height: number): Promise<void> {
    this.stripImage = { rgba, width, height }
  }

  async setBrightness(percent: number): Promise<void> {
    this.brightnessHistory.push(percent)
  }

  async clear(): Promise<void> {
    this.cleared = true
    this.keyImages.clear()
    this.stripImage = null
  }

  async close(): Promise<void> {
    this.closed = true
  }

  onInput(listener: (e: DeckInputEvent) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  emit(event: DeckInputEvent): void {
    for (const l of [...this.inputListeners]) l(event)
  }

  press(keyIndex: number): void {
    this.emit({ type: 'keyDown', keyIndex })
    this.emit({ type: 'keyUp', keyIndex })
  }

  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const l of [...this.disconnectListeners]) l()
  }

  changeListenerCount(): number {
    return this.inputListeners.size
  }
}
