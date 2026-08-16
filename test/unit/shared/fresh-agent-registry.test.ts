import { describe, expect, it } from 'vitest'

import { resolveFreshAgentType, resolveFreshAgentPaneCreateEffort } from '@/lib/fresh-agent-registry'

describe('fresh-agent registry', () => {
  it('keeps kilroy as a hidden claude-backed fresh-agent type', () => {
    expect(resolveFreshAgentType('kilroy')).toMatchObject({
      runtimeProvider: 'claude',
      hidden: true,
    })
  })

  it('registers freshcodex as a codex-backed session type', () => {
    expect(resolveFreshAgentType('freshcodex')).toMatchObject({
      runtimeProvider: 'codex',
      label: 'Freshcodex',
    })
  })
})

describe('resolveFreshAgentPaneCreateEffort', () => {
  it('keeps claude/codex falling back to the registry default effort', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
      providerEffort: undefined,
      fallbackEffort: 'high',
    })).toBe('high')
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBe('max')
  })

  it('passes an explicit freshopencode provider default through for live-catalog models', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      providerEffort: 'high',
      fallbackEffort: 'max',
    })).toBe('high')
  })

  it('does not fabricate a variant for live-catalog freshopencode models when no default is staged', () => {
    // A cleared provider default (the selector committed Default for this
    // model) must not come back as 'max' for new panes.
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBeUndefined()
  })

  it('keeps static-menu freshopencode models defaulting to the menu default when nothing is staged', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBe('max')
  })
})
