// Async bitmap cache for repo icons drawn on Stream Deck tiles.
// Canvas analogue of RepoIcon.tsx's <img> + onError-fallback: while a URL is
// loading (or after it fails) bitmapFor returns null and the tile renderer
// draws the letter avatar; when a load completes, subscribers (the deck
// controller) are notified so tiles repaint with the real icon.
// Failures are cached permanently for the session (like <img onError> ->
// letter avatar; the server caches negatives too).
// All error paths are SILENT - no console.error/console.warn (console.error is
// fatal in tests, and a failed icon is expected, not exceptional).

export type IconLoader = (url: string) => Promise<CanvasImageSource>

const defaultLoader: IconLoader = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`repo icon load failed: ${url}`))
    img.src = url
  })

/** True when the decoded bitmap actually draws pixels (guards the SVG drawn-empty trap). */
export type IconProbe = (bitmap: CanvasImageSource) => boolean

export const DRAWN_EMPTY_PROBE_SIZE = 16
/** Minimum fraction of non-transparent pixels for a draw to count as visible. */
export const DRAWN_EMPTY_MIN_ALPHA_COVERAGE = 0.01

/** Pure threshold logic (exported for unit tests): >= 1% of pixels have alpha > 0. */
export function hasDrawnPixels(data: Uint8ClampedArray): boolean {
  const pixels = data.length / 4
  let opaque = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) opaque++
  }
  return pixels > 0 && opaque / pixels >= DRAWN_EMPTY_MIN_ALPHA_COVERAGE
}

// Runtime-only drawn-empty probe. The server serves dimensionless SVGs first-class
// (repo_icon_detect.rs:51-52 "Unknown dimensions are acceptable"), and two servable
// shapes fire onload yet draw ~0 pixels in real Chromium (no-viewBox SVGs with
// off-viewport content; width/height=0 SVGs). Draw into a small internal canvas with
// EXPLICIT destination dims and count alpha; near-blank -> treat as failure so the
// letter avatar renders. In jsdom, getContext returns null: skip and trust the load.
const defaultProbe: IconProbe = (bitmap) => {
  const canvas = document.createElement('canvas')
  canvas.width = DRAWN_EMPTY_PROBE_SIZE
  canvas.height = DRAWN_EMPTY_PROBE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return true // jsdom / no 2D context: cannot probe, trust the load
  ctx.clearRect(0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE)
  ctx.drawImage(bitmap, 0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE)
  return hasDrawnPixels(ctx.getImageData(0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE).data)
}

export class IconImageCache {
  private bitmaps = new Map<string, CanvasImageSource>()
  private failed = new Set<string>()
  private pending = new Set<string>()
  private listeners = new Set<() => void>()

  constructor(
    private loader: IconLoader = defaultLoader,
    private probe: IconProbe = defaultProbe,
  ) {}

  /** Returns the decoded bitmap, or null while loading / after failure. Requests the load on first miss. */
  bitmapFor(url: string): CanvasImageSource | null {
    const hit = this.bitmaps.get(url)
    if (hit) return hit
    if (!this.failed.has(url) && !this.pending.has(url)) {
      this.pending.add(url)
      void this.loader(url).then(
        (bitmap) => {
          this.pending.delete(url)
          if (this.probe(bitmap)) {
            this.bitmaps.set(url, bitmap)
          } else {
            this.failed.add(url) // drew ~0 pixels: record as FAILED -> letter avatar
          }
          this.notify()
        },
        () => {
          this.pending.delete(url)
          this.failed.add(url)
          this.notify()
        },
      )
    }
    return null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

let singleton: IconImageCache | null = null

export function getIconImageCache(): IconImageCache {
  if (!singleton) singleton = new IconImageCache()
  return singleton
}

export function resetIconImageCacheForTests(cache?: IconImageCache): void {
  singleton = cache ?? null
}
