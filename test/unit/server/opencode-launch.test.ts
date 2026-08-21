import { describe, it, expect } from 'vitest'
import { getOpencodeEnvOverrides } from '../../../server/opencode-launch'

// Kata 7mtf: the env-key model heuristic (resolveOpencodeLaunchModel) was
// removed — a fresh opencode pane with no explicit model gets NO --model flag
// so opencode's own MRU/default model wins. Regression coverage for that
// behavior lives at the argv level in test/unit/server/terminal-registry.test.ts
// ('opencode launches never inject a heuristic model').
describe('opencode launch helpers', () => {
  it('maps GEMINI_API_KEY to GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(getOpencodeEnvOverrides({
      GEMINI_API_KEY: 'gemini-key',
    })).toEqual({
      GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-key',
    })
  })

  it('preserves an explicit GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(getOpencodeEnvOverrides({
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
      GEMINI_API_KEY: 'gemini-key',
    })).toEqual({})
  })
})
