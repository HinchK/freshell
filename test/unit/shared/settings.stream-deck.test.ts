import { describe, expect, it } from 'vitest'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  defaultLocalSettings,
  extractLegacyLocalSettingsSeed,
  resolveLocalSettings,
} from '@shared/settings'
import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'
import { parseBrowserPreferencesRaw } from '@/lib/browser-preferences'

describe('streamDeck local settings section', () => {
  it('has safe defaults', () => {
    expect(defaultLocalSettings.streamDeck).toEqual({
      enabled: false,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 300,
      tileStyle: 'status-icons',
      keyLayout: 'auto',
    })
  })

  it('round-trips a patch through resolve -> buildLocalSettingsPatch', () => {
    const resolved = resolveLocalSettings({
      streamDeck: { enabled: true, idleTimeoutSeconds: 60 },
    })
    expect(resolved.streamDeck).toEqual({
      enabled: true,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 60,
      tileStyle: 'status-icons',
      keyLayout: 'auto',
    })
    const patch = buildLocalSettingsPatch(resolved)
    expect(patch.streamDeck).toEqual({ enabled: true, idleTimeoutSeconds: 60 })
  })

  it('defaults produce no persisted patch entry', () => {
    expect(buildLocalSettingsPatch(resolveLocalSettings({})).streamDeck).toBeUndefined()
  })

  it('appears in ResolvedSettings', () => {
    const resolved = composeResolvedSettings(
      createDefaultServerSettings(),
      resolveLocalSettings({ streamDeck: { enabled: true } }),
    )
    expect(resolved.streamDeck.enabled).toBe(true)
    expect(resolved.streamDeck.brightness).toBe(100)
  })

  it('survives the legacy seed normalizer (load path)', () => {
    const seed = extractLegacyLocalSettingsSeed({
      streamDeck: { enabled: true, brightness: 80, tileStyle: 'terminal-previews' },
    })
    expect(seed?.streamDeck).toEqual({
      enabled: true,
      brightness: 80,
      tileStyle: 'terminal-previews',
    })
  })
})

describe('streamDeck.tileStyle', () => {
  it('defaults to status-icons', () => {
    expect(defaultLocalSettings.streamDeck.tileStyle).toBe('status-icons')
  })

  it('round-trips terminal-previews through patch normalization and persistence', () => {
    const resolved = resolveLocalSettings({
      streamDeck: { tileStyle: 'terminal-previews' },
    })
    expect(resolved.streamDeck.tileStyle).toBe('terminal-previews')
    const patch = buildLocalSettingsPatch(resolved)
    expect(patch.streamDeck?.tileStyle).toBe('terminal-previews')
  })

  it('drops invalid tileStyle values during extraction', () => {
    const seed = extractLegacyLocalSettingsSeed({
      streamDeck: { tileStyle: 'sparkly' },
    })
    expect(seed?.streamDeck?.tileStyle).toBeUndefined()
  })

  it('produces no persisted entry at the default value', () => {
    const local = resolveLocalSettings({})
    expect(buildLocalSettingsPatch(local).streamDeck?.tileStyle).toBeUndefined()
  })
})

describe('streamDeck.keyLayout', () => {
  it('defaults to auto', () => {
    expect(defaultLocalSettings.streamDeck.keyLayout).toBe('auto')
  })

  it('round-trips newest-first through patch normalization and persistence', () => {
    const resolved = resolveLocalSettings({
      streamDeck: { keyLayout: 'newest-first' },
    })
    expect(resolved.streamDeck.keyLayout).toBe('newest-first')
    const patch = buildLocalSettingsPatch(resolved)
    expect(patch.streamDeck?.keyLayout).toBe('newest-first')
  })

  it('drops invalid keyLayout values during extraction', () => {
    const seed = extractLegacyLocalSettingsSeed({
      streamDeck: { keyLayout: 'sideways' },
    })
    expect(seed?.streamDeck?.keyLayout).toBeUndefined()
  })

  it('produces no persisted entry at the default value', () => {
    const local = resolveLocalSettings({})
    expect(buildLocalSettingsPatch(local).streamDeck?.keyLayout).toBeUndefined()
  })

  it('survives the reload path: a parsed browser-preferences record preserves streamDeck.keyLayout', () => {
    const raw = JSON.stringify({ settings: { streamDeck: { keyLayout: 'newest-first' } } })
    const record = parseBrowserPreferencesRaw(raw)
    expect(record?.settings?.streamDeck?.keyLayout).toBe('newest-first')
  })
})
