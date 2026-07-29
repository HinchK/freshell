// Canvas-side bridge to the tab bar's coding-agent icons. The icons exist
// ONLY as React SVG components drawing with currentColor
// (provider-icons.tsx + fresh-agent-registry.ts), so we serialize them with
// renderToStaticMarkup and inject the tint via a color attribute on the root
// <svg> — inside an <img>-loaded SVG, currentColor resolves through the
// inherited `color` property, which tints solid fills AND strokes (KilroyIcon
// is stroke-based). The data URL feeds the existing IconImageCache: same
// async load, same drawn-empty probe, same silent failure -> no-icon path.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultProviderIcon, PROVIDER_ICONS } from '@/components/icons/provider-icons'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

const markupCache = new Map<string, string>()

/**
 * Standalone tinted SVG markup for a provider. `provider` is a terminal
 * mode ('claude', 'codex', ...) or a fresh-agent sessionType ('freshclaude',
 * ...); anything unknown gets DefaultProviderIcon (same rule as PaneIcon).
 */
export function providerIconSvg(provider: string, colorHex: string): string {
  const key = `${provider}\u0000${colorHex}`
  const hit = markupCache.get(key)
  if (hit) return hit
  const Icon =
    resolveFreshAgentType(provider)?.icon ??
    // `provider` is an open string; PROVIDER_ICONS is Record<CodingCliProviderName, ...>,
    // so a plain string index is TS7053 under strict. Same cast as session-type-utils.ts.
    PROVIDER_ICONS[provider as keyof typeof PROVIDER_ICONS] ??
    DefaultProviderIcon
  const raw = renderToStaticMarkup(createElement(Icon))
  let svg = raw.replace('<svg', `<svg color="${colorHex}"`)
  // Standalone SVG (loaded via <img src="data:...\">) requires xmlns; React
  // components may or may not declare it.
  if (!svg.includes('xmlns=')) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  markupCache.set(key, svg)
  return svg
}

/** Stable per-(provider, tint) data URL for IconImageCache and KeySpec diffing. */
export function providerIconDataUrl(provider: string, colorHex: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(providerIconSvg(provider, colorHex))}`
}
