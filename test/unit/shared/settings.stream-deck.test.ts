import { describe, expect, it } from 'vitest'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  defaultLocalSettings,
  extractLegacyLocalSettingsSeed,
  resolveLocalSettings,
} from '@shared/settings'
import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'

describe('streamDeck local settings section', () => {
  it('has safe defaults', () => {
    expect(defaultLocalSettings.streamDeck).toEqual({
      enabled: false,
      brightness: 100,
      idleBrightness: 10,
      idleTimeoutSeconds: 300,
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
      streamDeck: { enabled: true, brightness: 80 },
    })
    expect(seed?.streamDeck).toEqual({ enabled: true, brightness: 80 })
  })
})
