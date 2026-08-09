import { describe, it, expect, vi } from 'vitest'
import {
  byRole,
  byLabel,
  byTitle,
  ariaNamePattern,
  SELECTOR_ENGINE_GUIDANCE,
} from './accessible-interactions.js'

/**
 * HARNESS-11 unit tests — pure-node halves of the accessible-interactions
 * helper (name guards, name-pattern escaping, shared guidance text). The
 * browser-bound halves (`expectAccessible`, `focusByKeyboard`) are exercised
 * by the Playwright self-test `specs/harness-11-a11y-gate.spec.ts`.
 */

function mockScope() {
  return {
    getByRole: vi.fn((...args: unknown[]) => ({ kind: 'role', args })),
    getByLabel: vi.fn((...args: unknown[]) => ({ kind: 'label', args })),
    getByTitle: vi.fn((...args: unknown[]) => ({ kind: 'title', args })),
  }
}

describe('byRole', () => {
  it('requires a non-empty accessible name (string)', () => {
    const scope = mockScope()
    expect(() => byRole(scope as never, 'button', '')).toThrow(/accessible name/)
    expect(() => byRole(scope as never, 'button', '   ')).toThrow(/accessible name/)
    expect(scope.getByRole).not.toHaveBeenCalled()
  })

  it('names the role and the guidance in the empty-name error', () => {
    const scope = mockScope()
    expect(() => byRole(scope as never, 'button', '')).toThrow(/button/)
    expect(() => byRole(scope as never, 'button', '')).toThrow(/HARNESS-11/)
  })

  it('passes a valid name through to getByRole with the name option', () => {
    const scope = mockScope()
    byRole(scope as never, 'button', 'New shell tab')
    expect(scope.getByRole).toHaveBeenCalledWith('button', { name: 'New shell tab' })
  })

  it('accepts a single non-whitespace character name (e.g. a "×" close glyph)', () => {
    const scope = mockScope()
    byRole(scope as never, 'button', '×')
    expect(scope.getByRole).toHaveBeenCalledWith('button', { name: '×' })
  })

  it('accepts a RegExp name verbatim', () => {
    const scope = mockScope()
    const name = /^Hide sidebar$/
    byRole(scope as never, 'button', name)
    expect(scope.getByRole).toHaveBeenCalledWith('button', { name })
  })

  it('forwards extra locator options (exact, expanded, ...) alongside the name', () => {
    const scope = mockScope()
    byRole(scope as never, 'tab', 'Terminal 1', { exact: true })
    expect(scope.getByRole).toHaveBeenCalledWith('tab', { name: 'Terminal 1', exact: true })
  })
})

describe('byLabel / byTitle', () => {
  it('byLabel requires a non-empty label', () => {
    const scope = mockScope()
    expect(() => byLabel(scope as never, '')).toThrow(/accessible label/)
    byLabel(scope as never, 'Search sessions')
    expect(scope.getByLabel).toHaveBeenCalledWith('Search sessions', undefined)
  })

  it('byTitle requires a non-empty title', () => {
    const scope = mockScope()
    expect(() => byTitle(scope as never, '  ')).toThrow()
    byTitle(scope as never, /^Close$/)
    expect(scope.getByTitle).toHaveBeenCalledWith(/^Close$/, undefined)
  })
})

describe('ariaNamePattern', () => {
  it('anchors the name for an exact match', () => {
    expect(ariaNamePattern('Hide sidebar')).toEqual(/^Hide sidebar$/)
  })

  it('escapes regex metacharacters so names match literally', () => {
    const pattern = ariaNamePattern('Terminal (2+1) [main]')
    expect(pattern.test('Terminal (2+1) [main]')).toBe(true)
    expect(pattern.test('Terminal X2+1Y [main]')).toBe(false)
  })

  it('does not match prefixes or suffixes', () => {
    const pattern = ariaNamePattern('Shell')
    expect(pattern.test('Shell')).toBe(true)
    expect(pattern.test('Shells')).toBe(false)
    expect(pattern.test('My Shell')).toBe(false)
  })
})

describe('SELECTOR_ENGINE_GUIDANCE', () => {
  it('points at role/label-based selection and the gate evidence doc', () => {
    expect(SELECTOR_ENGINE_GUIDANCE).toMatch(/getByRole/)
    expect(SELECTOR_ENGINE_GUIDANCE).toMatch(/HARNESS-11/)
  })
})
