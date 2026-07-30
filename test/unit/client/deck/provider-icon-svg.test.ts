import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { providerIconDataUrl, providerIconSvg } from '@/deck/provider-icon-svg'
import { ClaudeIcon, DefaultProviderIcon, KilroyIcon } from '@/components/icons/provider-icons'

describe('providerIconSvg', () => {
  it('serializes a terminal-mode provider to standalone SVG with the tint color on the root', () => {
    const svg = providerIconSvg('claude', '#3b82f6')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('color="#3b82f6"')
    // Same geometry as the tab bar's component (currentColor paths preserved).
    const raw = renderToStaticMarkup(createElement(ClaudeIcon))
    expect(svg).toContain(raw.slice(raw.indexOf('<path')))
  })

  it('resolves fresh-agent sessionTypes via the registry (freshclaude) and strokes via color (kilroy)', () => {
    expect(providerIconSvg('freshclaude', '#21c45d')).toContain('color="#21c45d"')
    const kilroy = providerIconSvg('kilroy', '#21c45d')
    expect(kilroy).toContain('color="#21c45d"')
    expect(kilroy).toContain(renderToStaticMarkup(createElement(KilroyIcon)).slice(0, 4)) // sanity: it serialized
  })

  it('unknown providers fall back to DefaultProviderIcon', () => {
    const svg = providerIconSvg('mystery-cli', '#a1a1aa')
    const raw = renderToStaticMarkup(createElement(DefaultProviderIcon))
    expect(svg).toContain(raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')))
  })

  it('memoizes markup and produces a stable, encoded data URL', () => {
    expect(providerIconSvg('claude', '#3b82f6')).toBe(providerIconSvg('claude', '#3b82f6'))
    const url = providerIconDataUrl('claude', '#3b82f6')
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(url).toBe(providerIconDataUrl('claude', '#3b82f6'))
    expect(url).not.toContain('<') // encoded
  })

  it('does not duplicate xmlns when the component already declares it', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'gemini', 'freshclaude']) {
      const svg = providerIconSvg(provider, '#ffffff')
      expect(svg.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)?.length).toBe(1)
    }
  })
})
