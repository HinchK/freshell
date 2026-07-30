// Deck tile typeface: Inter, bundled locally via @fontsource (src/index.css
// imports weights 400/600 — no CDN fetch). Canvas ctx.font does NOT trigger
// webfont loading, so the deck controller waits for the FontFace load and
// forces a repaint; until then every deck font string falls back to
// sans-serif (DECK_FONT_STACK lists it second) without breaking.
// jsdom has no document.fonts: every path here degrades to a silent no-op
// (console.error is fatal in tests; a missing font is expected, not
// exceptional — same rule as icon-image-cache.ts).
// Two verified FontFaceSet facts shape this module: (1) fonts.load('400 16px
// "Inter"') uses load()'s default sample text (a single space), so it loads
// only the latin-subset face — non-Latin deck text stays in the sans-serif
// fallback (accepted as fine for v1); (2) load() REJECTS on a broken src, so
// the .catch below is MANDATORY (without it a failed load is an unhandled
// rejection, which is fatal under the test rules).

export const DECK_FONT_FAMILY = 'Inter'
/** Family list for ctx.font strings: Inter once loaded, sans-serif before. */
export const DECK_FONT_STACK = `${DECK_FONT_FAMILY}, sans-serif`

/**
 * Invoke onReady once the deck's font weights (400 + 600) are loaded so the
 * caller can repaint with Inter. Returns a cancel function — after cancel a
 * late load is ignored (the controller calls it from stop()).
 */
export function whenDeckFontReady(onReady: () => void): () => void {
  let cancelled = false
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load) return () => { cancelled = true }
  void Promise.all([
    fonts.load(`400 16px "${DECK_FONT_FAMILY}"`),
    fonts.load(`600 16px "${DECK_FONT_FAMILY}"`),
  ])
    .then(() => {
      if (!cancelled) onReady()
    })
    .catch(() => {
      // Font failure -> keep the sans-serif fallback, silently.
    })
  return () => { cancelled = true }
}
