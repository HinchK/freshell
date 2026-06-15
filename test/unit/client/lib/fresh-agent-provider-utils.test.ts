import { describe, it, expect } from 'vitest'
import {
  FRESH_AGENT_PROVIDER_CONFIGS,
  FRESH_AGENT_PROVIDERS,
  isFreshAgentProviderName,
  getFreshAgentProviderConfig,
  getFreshAgentProviderLabel,
  getVisibleFreshAgentConfigs,
} from '@/lib/fresh-agent-provider-utils'

describe('fresh-agent-provider-utils', () => {
  it('exports at least one provider', () => {
    expect(FRESH_AGENT_PROVIDERS.length).toBeGreaterThan(0)
    expect(FRESH_AGENT_PROVIDER_CONFIGS.length).toBeGreaterThan(0)
  })

  it('freshclaude is a valid provider', () => {
    expect(isFreshAgentProviderName('freshclaude')).toBe(true)
  })

  it('rejects unknown provider names', () => {
    expect(isFreshAgentProviderName('unknown')).toBe(false)
    expect(isFreshAgentProviderName(undefined)).toBe(false)
  })

  it('returns config for freshclaude', () => {
    const config = getFreshAgentProviderConfig('freshclaude')
    expect(config).toBeDefined()
    expect(config!.label).toBe('Freshclaude')
    expect(config!.providerDefaultModelId).toBe('opus')
    expect(config!.defaultPermissionMode).toBe('bypassPermissions')
    expect('defaultEffort' in config!).toBe(false)
  })

  it('returns undefined for unknown provider', () => {
    expect(getFreshAgentProviderConfig('nope')).toBeUndefined()
  })

  it('returns label for known provider', () => {
    expect(getFreshAgentProviderLabel('freshclaude')).toBe('Freshclaude')
  })

  it('returns fallback label for unknown provider', () => {
    expect(getFreshAgentProviderLabel('nope')).toBe('Fresh Agent')
  })

  it('kilroy is a valid provider', () => {
    expect(isFreshAgentProviderName('kilroy')).toBe(true)
  })

  it('returns config for kilroy', () => {
    const config = getFreshAgentProviderConfig('kilroy')
    expect(config).toBeDefined()
    expect(config!.name).toBe('kilroy')
    expect(config!.label).toBe('Kilroy')
    expect(config!.codingCliProvider).toBe('claude')
    expect(config!.providerDefaultModelId).toBe('opus')
    expect(config!.defaultPermissionMode).toBe('bypassPermissions')
    expect('defaultEffort' in config!).toBe(false)
    expect(config!.pickerShortcut).not.toBe('A') // must differ from freshclaude
  })

  it('returns label for kilroy provider', () => {
    expect(getFreshAgentProviderLabel('kilroy')).toBe('Kilroy')
  })

  it('all providers have unique picker shortcuts', () => {
    const shortcuts = FRESH_AGENT_PROVIDER_CONFIGS.map((c) => c.pickerShortcut)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('kilroy config has hidden flag set to true', () => {
    const config = getFreshAgentProviderConfig('kilroy')
    expect(config!.hidden).toBe(true)
  })

  it('freshclaude config does not have hidden flag', () => {
    const config = getFreshAgentProviderConfig('freshclaude')
    expect(config!.hidden).toBeUndefined()
  })

  describe('getVisibleFreshAgentConfigs', () => {
    it('excludes hidden providers when no feature flags are set', () => {
      const visible = getVisibleFreshAgentConfigs({})
      const names = visible.map((c) => c.name)
      expect(names).toContain('freshclaude')
      expect(names).not.toContain('kilroy')
    })

    it('includes hidden providers when their feature flag is true', () => {
      const visible = getVisibleFreshAgentConfigs({ kilroy: true })
      const names = visible.map((c) => c.name)
      expect(names).toContain('freshclaude')
      expect(names).toContain('kilroy')
    })

    it('still excludes hidden providers when their feature flag is false', () => {
      const visible = getVisibleFreshAgentConfigs({ kilroy: false })
      const names = visible.map((c) => c.name)
      expect(names).toContain('freshclaude')
      expect(names).not.toContain('kilroy')
    })
  })
})
