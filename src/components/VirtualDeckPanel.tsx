// In-app Stream Deck emulator: drives a FakeDeckDevice through the REAL
// DeckController so the full pipeline (frame diff, paging, long-press action
// layer, dials) is exercised without hardware. Opened via the Settings toggle
// (state.deck.virtualDeckOpen).
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { setVirtualDeckOpen } from '@/store/deckSlice'
import { FakeDeckDevice, MINI_CAPS, PLUS_CAPS } from '@/deck/fake-deck-device'
import { DeckController } from '@/deck/deck-controller'
import { renderKey, renderStrip, type Ctx2D, type CtxFactory, ensureRoundRect } from '@/deck/tile-renderer'
import { getIconImageCache } from '@/deck/icon-image-cache'
import { SegmentedControl } from '@/components/settings/settings-controls'

type Profile = 'mini' | 'plus'

const PROFILE_CAPS = { mini: MINI_CAPS, plus: PLUS_CAPS } as const

// The controller's default renderers throw when getContext('2d') returns null
// (jsdom). Fall back to a no-op context so rendering silently degrades to a
// blank buffer instead of crashing — tests assert store effects, not pixels.
function noopCtx(width: number, height: number): Ctx2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    letterSpacing: '',
    textBaseline: 'top' as CanvasTextBaseline,
    fillRect: () => {},
    fillText: () => {},
    drawImage: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    stroke: () => {},
    roundRect: () => {},
    measureText: () => ({ width: 0 }) as TextMetrics,
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
  }
}

const safeCtxFactory: CtxFactory = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return noopCtx(width, height)
  ensureRoundRect(ctx)
  return ctx as unknown as Ctx2D
}

const DIAL_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md border border-border text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'

export default function VirtualDeckPanel() {
  // Defensive read (matches useEnsureExtensionsRegistry): App-level tests
  // build partial stores that may omit the deck slice.
  const open = useAppSelector((s) => s.deck?.virtualDeckOpen ?? false)
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const [profile, setProfile] = useState<Profile>('mini')
  const caps = PROFILE_CAPS[profile]

  const keyCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const stripCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const deviceRef = useRef<FakeDeckDevice | null>(null)
  const pressedKeysRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    const deviceCaps = PROFILE_CAPS[profile]
    const device = new FakeDeckDevice(deviceCaps)
    // Mirror device paints onto the panel's canvases (no-op under jsdom where
    // getContext returns null).
    const origSetKeyImage = device.setKeyImage.bind(device)
    device.setKeyImage = async (keyIndex, rgba) => {
      await origSetKeyImage(keyIndex, rgba)
      const ctx = keyCanvasRefs.current[keyIndex]?.getContext('2d')
      if (!ctx) return
      // Copy into a fresh ArrayBuffer-backed array: ImageData rejects
      // ArrayBufferLike-typed views.
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), deviceCaps.keyPixelWidth, deviceCaps.keyPixelHeight), 0, 0)
    }
    const origSetTouchStripImage = device.setTouchStripImage.bind(device)
    device.setTouchStripImage = async (rgba, width, height) => {
      await origSetTouchStripImage(rgba, width, height)
      const ctx = stripCanvasRef.current?.getContext('2d')
      if (!ctx) return
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
    }
    deviceRef.current = device
    const pressedKeys = pressedKeysRef.current
    const controller = new DeckController({
      store,
      device,
      renderKey: (spec, c) => renderKey(spec, c, safeCtxFactory, (url) => getIconImageCache().bitmapFor(url)),
      renderStrip: (text, width, height) => renderStrip(text, width, height, safeCtxFactory),
      settings: () => store.getState().settings.settings.streamDeck,
    })
    controller.start()
    return () => {
      controller.stop()
      deviceRef.current = null
      pressedKeys.clear()
    }
  }, [open, profile, store])

  const pressKey = useCallback((keyIndex: number) => {
    if (pressedKeysRef.current.has(keyIndex)) return
    pressedKeysRef.current.add(keyIndex)
    deviceRef.current?.emit({ type: 'keyDown', keyIndex })
  }, [])

  const releaseKey = useCallback((keyIndex: number) => {
    if (!pressedKeysRef.current.delete(keyIndex)) return
    deviceRef.current?.emit({ type: 'keyUp', keyIndex })
  }, [])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Virtual Stream Deck"
      className="fixed bottom-4 right-4 z-[70] rounded-lg border border-border bg-background p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Virtual Stream Deck</span>
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={profile}
            options={[
              { value: 'mini', label: 'Mini' },
              { value: 'plus', label: 'Plus' },
            ]}
            onChange={(value) => setProfile(value as Profile)}
          />
          <button
            type="button"
            onClick={() => dispatch(setVirtualDeckOpen(false))}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Close virtual deck"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div className={`grid gap-2 ${caps.keyColumns === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {Array.from({ length: caps.keyCount }, (_, i) => (
          <button
            key={`${profile}-${i}`}
            type="button"
            aria-label={`Deck key ${i + 1}`}
            className="overflow-hidden rounded-md border border-border bg-black p-0"
            onPointerDown={() => pressKey(i)}
            onPointerUp={() => releaseKey(i)}
            onPointerLeave={() => releaseKey(i)}
            onKeyDown={(e) => {
              // Keyboard long-press parity: hold Space/Enter >=0.5s for the action layer.
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault()
                pressKey(i)
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                releaseKey(i)
              }
            }}
          >
            <canvas
              ref={(el) => {
                keyCanvasRefs.current[i] = el
              }}
              width={caps.keyPixelWidth}
              height={caps.keyPixelHeight}
              className="block h-16 w-16"
            />
          </button>
        ))}
      </div>
      {caps.hasTouchStrip && (
        <canvas
          ref={stripCanvasRef}
          width={caps.touchStripPixelWidth}
          height={caps.touchStripPixelHeight}
          className="mt-2 block h-8 w-full rounded-md border border-border bg-black"
        />
      )}
      {caps.dialCount > 0 && (
        <div className="mt-2 flex items-center justify-between gap-3">
          {[0, 1].map((dialIndex) => (
            <div key={dialIndex} className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">Dial {dialIndex + 1}</span>
              <button
                type="button"
                aria-label={`Dial ${dialIndex + 1} rotate left`}
                className={DIAL_BUTTON_CLASS}
                onClick={() => deviceRef.current?.emit({ type: 'dialRotate', dialIndex, ticks: -1 })}
              >
                &lsaquo;
              </button>
              <button
                type="button"
                aria-label={`Press dial ${dialIndex + 1}`}
                className={DIAL_BUTTON_CLASS}
                onClick={() => deviceRef.current?.emit({ type: 'dialPress', dialIndex })}
              >
                &bull;
              </button>
              <button
                type="button"
                aria-label={`Dial ${dialIndex + 1} rotate right`}
                className={DIAL_BUTTON_CLASS}
                onClick={() => deviceRef.current?.emit({ type: 'dialRotate', dialIndex, ticks: 1 })}
              >
                &rsaquo;
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
