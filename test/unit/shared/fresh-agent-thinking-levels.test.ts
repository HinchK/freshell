import { describe, expect, it } from 'vitest'

import {
  highestThinkingLevelId,
  orderThinkingLevelIds,
} from '../../../shared/fresh-agent-thinking-levels.js'

describe('orderThinkingLevelIds', () => {
  it('orders known levels canonically regardless of served order', () => {
    expect(orderThinkingLevelIds(['max', 'low', 'high'])).toEqual(['low', 'high', 'max'])
  })

  it('ranks none and off below minimal, keeping served order on rank ties', () => {
    expect(orderThinkingLevelIds(['high', 'off', 'minimal', 'none'])).toEqual([
      'off',
      'none',
      'minimal',
      'high',
    ])
    expect(orderThinkingLevelIds(['none', 'off'])).toEqual(['none', 'off'])
  })

  it('ranks unknown names after the known levels, preserving served relative order', () => {
    // minimax-m3's real variants are exactly none + thinking.
    expect(orderThinkingLevelIds(['thinking', 'high', 'low'])).toEqual(['low', 'high', 'thinking'])
    expect(orderThinkingLevelIds(['zebra', 'alpha', 'max'])).toEqual(['max', 'zebra', 'alpha'])
  })

  it('keeps single-level lists as-is', () => {
    expect(orderThinkingLevelIds(['max'])).toEqual(['max'])
  })

  it('drops blank ids and dedupes repeats', () => {
    expect(orderThinkingLevelIds(['high', '', '  ', 'high', 'low'])).toEqual(['low', 'high'])
  })

  it('does not mutate the input', () => {
    const input = ['max', 'low']
    orderThinkingLevelIds(input)
    expect(input).toEqual(['max', 'low'])
  })

  it('returns an empty list for an empty input', () => {
    expect(orderThinkingLevelIds([])).toEqual([])
  })
})

describe('highestThinkingLevelId', () => {
  it('picks the canonically highest level (real catalogs)', () => {
    expect(highestThinkingLevelId(['low', 'high', 'max'])).toBe('max')
    expect(highestThinkingLevelId(['max'])).toBe('max')
    expect(highestThinkingLevelId(['none', 'thinking'])).toBe('thinking')
    expect(
      highestThinkingLevelId(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off']),
    ).toBe('max')
  })

  it('returns undefined for an empty list', () => {
    expect(highestThinkingLevelId([])).toBeUndefined()
  })
})
