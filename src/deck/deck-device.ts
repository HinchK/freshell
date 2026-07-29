export interface DeckCapabilities {
  model: string
  keyCount: number
  keyRows: number
  keyColumns: number
  keyPixelWidth: number
  keyPixelHeight: number
  dialCount: number
  hasTouchStrip: boolean
  touchStripPixelWidth: number   // 0 when hasTouchStrip is false
  touchStripPixelHeight: number  // 0 when hasTouchStrip is false
}

export type DeckInputEvent =
  | { type: 'keyDown'; keyIndex: number }
  | { type: 'keyUp'; keyIndex: number }
  | { type: 'dialRotate'; dialIndex: number; ticks: number }
  | { type: 'dialPress'; dialIndex: number }
  | { type: 'touchTap' }

export interface DeckDevice {
  readonly capabilities: DeckCapabilities
  setKeyImage(keyIndex: number, rgba: Uint8ClampedArray): Promise<void>
  setTouchStripImage(rgba: Uint8ClampedArray, width: number, height: number): Promise<void>
  setBrightness(percent: number): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
  onInput(listener: (event: DeckInputEvent) => void): () => void
  onDisconnect(listener: () => void): () => void
}
