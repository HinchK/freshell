import { describe, it, expect } from 'vitest'
import {
  emptyBaseline,
  mergeReport,
  applyAttribution,
  tallyVerdicts,
  SUITE_SPEC_COUNT,
  type Gate01Baseline,
  type PlaywrightJsonReport,
} from './gate01-collate.js'

/**
 * GATE-01 collator unit tests. Fixture mirrors the Playwright 1.58 JSON
 * reporter shape (suites tree -> specs -> tests(projects) -> results).
 */

function pwTest(projectName: string, status: string, opts: { annotations?: object[]; duration?: number; error?: string } = {}) {
  return {
    timeout: 60000,
    annotations: opts.annotations ?? [],
    expectedStatus: 'passed',
    projectName,
    results: [
      {
        workerIndex: 0,
        status: status === 'skipped' ? 'skipped' : status === 'unexpected' ? 'failed' : 'passed',
        duration: opts.duration ?? 10,
        errors: opts.error ? [{ message: opts.error }] : [],
        stdout: [],
        stderr: [],
        retry: 0,
        startTime: '2026-08-09T00:00:00.000Z',
      },
    ],
    status,
  }
}

function pwSpec(title: string, line: number, tests: object[]) {
  return { title, ok: true, tags: [], tests, id: `id-${line}`, file: 'x.spec.ts', line, column: 1 }
}

function pwReport(suites: object[]): PlaywrightJsonReport {
  return { suites, errors: [], stats: {} } as unknown as PlaywrightJsonReport
}

describe('gate01-collate', () => {
  it('emptyBaseline seeds all 69 suite specs as pending on both legs', () => {
    const b = emptyBaseline('abc123', { 'a.spec.ts': 'product', 'b.spec.ts': 'harness' }, 'deadbeef')
    expect(b.schema).toBe(1)
    expect(b.head).toBe('abc123')
    expect(b.rustServerBinSha256).toBe('deadbeef')
    expect(Object.keys(b.specs)).toEqual(['a.spec.ts', 'b.spec.ts'])
    expect(b.specs['a.spec.ts'].legs.legacy.verdict).toBe('pending')
    expect(b.specs['a.spec.ts'].legs.rust.verdict).toBe('pending')
    expect(b.specs['b.spec.ts'].bucket).toBe('harness')
    expect(b.suiteDefinition.specCount).toBe(2)
  })

  it('mergeReport tallies pass/fail/skip/expectedFail per spec per leg', () => {
    let b = emptyBaseline('abc', { 'x.spec.ts': 'product' }, 'bin')
    const report = pwReport([
      {
        title: 'x.spec.ts',
        file: 'x.spec.ts',
        specs: [
          pwSpec('plain pass', 10, [
            pwTest('gate01-legacy', 'expected'),
            pwTest('gate01-rust', 'expected'),
          ]),
          pwSpec('rust gap', 20, [
            pwTest('gate01-legacy', 'expected'),
            pwTest('gate01-rust', 'unexpected', { error: 'expect(received).toBe(expected)' }),
          ]),
          pwSpec('pinned rust fail', 30, [
            pwTest('gate01-legacy', 'expected'),
            pwTest('gate01-rust', 'expected', { annotations: [{ type: 'fail', description: 'CFG-12: gap' }] }),
          ]),
          pwSpec('legacy-only skip', 40, [
            pwTest('gate01-legacy', 'skipped', { annotations: [{ type: 'skip', description: 'KNOWN DIVERGENCE' }] }),
            pwTest('gate01-rust', 'expected'),
          ]),
        ],
        suites: [],
      },
    ])
    b = mergeReport(b, report, 'slice-1')
    const L = b.specs['x.spec.ts'].legs
    expect(L.legacy).toMatchObject({ verdict: 'pass', passed: 3, failed: 0, skipped: 1, expectedFail: 0 })
    expect(L.rust).toMatchObject({ verdict: 'fail', passed: 2, failed: 1, expectedFail: 1 })
    expect(L.rust.failures).toHaveLength(1)
    expect(L.rust.failures[0]).toMatchObject({ title: 'rust gap', line: 20 })
    expect(L.rust.failures[0].error).toContain('expect(received)')
    expect(L.legacy.runs).toEqual(['slice-1'])
    expect(L.rust.runs).toEqual(['slice-1'])
  })

  it('mergeReport walks nested describe suites', () => {
    let b = emptyBaseline('abc', { 'n.spec.ts': 'product' }, 'bin')
    const report = pwReport([
      {
        title: 'n.spec.ts',
        file: 'n.spec.ts',
        specs: [],
        suites: [
          {
            title: 'describe',
            file: 'n.spec.ts',
            specs: [pwSpec('nested pass', 5, [pwTest('gate01-legacy', 'expected')])],
            suites: [],
          },
        ],
      },
    ])
    b = mergeReport(b, report, 'slice-1')
    expect(b.specs['n.spec.ts'].legs.legacy.verdict).toBe('pass')
  })

  it('mergeReport is additive across specs, replaces per-leg counters on re-run, keeps run history, never clobbers attribution', () => {
    let b = emptyBaseline('abc', { 'x.spec.ts': 'product', 'y.spec.ts': 'product' }, 'bin')
    b = mergeReport(b, pwReport([
      { title: 'x.spec.ts', file: 'x.spec.ts', specs: [pwSpec('p', 1, [pwTest('gate01-rust', 'unexpected', { error: 'boom' })])], suites: [] },
    ]), 'slice-1')
    b = applyAttribution(b, 'x.spec.ts', 'rust', { kind: 'flake', verdict: 'flaky-reproven', reproof: ['r1', 'r2'] })
    expect(b.specs['x.spec.ts'].legs.rust.verdict).toBe('flaky-reproven')
    b = mergeReport(b, pwReport([
      { title: 'y.spec.ts', file: 'y.spec.ts', specs: [pwSpec('p', 1, [pwTest('gate01-legacy', 'expected')])], suites: [] },
    ]), 'slice-2')
    expect(b.specs['x.spec.ts'].legs.rust.verdict).toBe('flaky-reproven')
    expect(b.specs['x.spec.ts'].legs.rust.attribution).toMatchObject({ kind: 'flake', reproof: ['r1', 'r2'] })
    expect(b.specs['y.spec.ts'].legs.legacy.verdict).toBe('pass')

    // Re-run of the SAME spec leg: counters replaced (not doubled), history kept.
    b = mergeReport(b, pwReport([
      { title: 'x.spec.ts', file: 'x.spec.ts', specs: [pwSpec('p', 1, [pwTest('gate01-rust', 'expected')]), pwSpec('p2', 2, [pwTest('gate01-rust', 'expected')])], suites: [] },
    ]), 'reproof-1')
    const rust = b.specs['x.spec.ts'].legs.rust
    expect(rust.passed).toBe(2)
    expect(rust.failed).toBe(0)
    expect(rust.runs).toEqual(['slice-1', 'reproof-1'])
    expect(rust.runHistory).toEqual([
      expect.objectContaining({ run: 'slice-1', failed: 1 }),
      expect.objectContaining({ run: 'reproof-1', passed: 2, failed: 0 }),
    ])
    expect(rust.attribution).toMatchObject({ kind: 'flake' })
    expect(rust.failures).toEqual([])
  })

  it('a spec skipped on every test reports skip-all', () => {
    let b = emptyBaseline('abc', { 's.spec.ts': 'product' }, 'bin')
    b = mergeReport(b, pwReport([
      {
        title: 's.spec.ts', file: 's.spec.ts', suites: [],
        specs: [pwSpec('s1', 1, [pwTest('gate01-legacy', 'skipped')]), pwSpec('s2', 2, [pwTest('gate01-legacy', 'skipped')])],
      },
    ]), 'slice-1')
    expect(b.specs['s.spec.ts'].legs.legacy.verdict).toBe('skip-all')
  })

  it('mergeReport throws on a spec file outside the suite definition', () => {
    const b = emptyBaseline('abc', { 'x.spec.ts': 'product' }, 'bin')
    expect(() => mergeReport(b, pwReport([
      { title: 'stray.spec.ts', file: 'stray.spec.ts', specs: [pwSpec('p', 1, [pwTest('gate01-legacy', 'expected')])], suites: [] },
    ]), 'slice-1')).toThrow(/stray\.spec\.ts/)
  })

  it('tallyVerdicts summarizes per leg', () => {
    let b = emptyBaseline('abc', { 'a.spec.ts': 'product', 'b.spec.ts': 'product', 'c.spec.ts': 'harness' }, 'bin')
    b = mergeReport(b, pwReport([
      { title: 'a.spec.ts', file: 'a.spec.ts', suites: [], specs: [pwSpec('p', 1, [pwTest('gate01-legacy', 'expected'), pwTest('gate01-rust', 'expected')])] },
      { title: 'b.spec.ts', file: 'b.spec.ts', suites: [], specs: [pwSpec('p', 1, [pwTest('gate01-legacy', 'expected'), pwTest('gate01-rust', 'unexpected', { error: 'x' })])] },
    ]), 's1')
    b = applyAttribution(b, 'b.spec.ts', 'rust', { kind: 'gap', owner: 'TERM-99' })
    const t = tallyVerdicts(b)
    expect(t.legacy.pass).toBe(2)
    expect(t.legacy.pending).toBe(1)
    expect(t.rust.pass).toBe(1)
    expect(t.rust.fail).toBe(1)
    expect(t.gaps).toEqual([{ spec: 'b.spec.ts', leg: 'rust', owner: 'TERM-99' }])
  })

  it('suite spec count constant matches the plan (69)', () => {
    expect(SUITE_SPEC_COUNT).toBe(69)
  })
})
