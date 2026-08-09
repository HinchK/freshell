import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifySelector,
  evaluateScan,
  readBaseline,
  scanSource,
  signatureOf,
  writeBaseline,
  type Baseline,
  type Violation,
  type ViolationCode,
} from './a11y-selector-gate.js'

/**
 * HARNESS-11 static-gate unit tests — the committed red/green bite
 * demonstration for the accessibility selector gate. The bad/good probe
 * fixtures are read from disk so the bite proof covers real file scanning,
 * not just inline strings.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BAD_PROBE = path.resolve(__dirname, '../fixtures/a11y-gate/css-dependent.bad.ts')
const GOOD_PROBE = path.resolve(__dirname, '../fixtures/a11y-gate/role-name.good.ts')

const codes = (vs: Violation[]) => vs.map((v) => `${v.code}@${v.line}`)

describe('scanSource — committed probe fixtures (the bite)', () => {
  it('flags every CSS-implementation-dependent selector in the bad probe with the expected code', () => {
    const vs = scanSource(readFileSync(BAD_PROBE, 'utf8'), BAD_PROBE)
    expect(vs.length).toBe(6)
    expect(vs.map((v) => v.code)).toEqual([
      'structural-combinator',
      'css-class',
      'xpath',
      'parent-traversal',
      'structural-pseudo',
      'css-class',
    ])
    // Diagnostics are actionable: the message carries the offending selector
    // text plus the remediation guidance.
    for (const v of vs) {
      expect(v.selector.length).toBeGreaterThan(0)
      expect(v.message).toMatch(/HARNESS-11/)
      expect(v.method).toBe('locator')
    }
  })

  it('reports zero violations for the role/name good probe', () => {
    expect(scanSource(readFileSync(GOOD_PROBE, 'utf8'), GOOD_PROBE)).toEqual([])
  })
})

describe('classifySelector — forbidden and permitted shapes', () => {
  it.each([
    ['.font-medium', 'css-class'],
    ['div.h-3.w-3[data-selected="true"]', 'css-class'],
    ['.fresh-agent-layout .xterm', 'css-class'], // non-exempt class present even beside a widget root
    ['xpath=//div[3]', 'xpath'],
    ['..', 'parent-traversal'],
    ['div li:nth-child(2)', 'structural-pseudo'],
    ['tr:first-child', 'structural-pseudo'],
    ['li:last-child', 'structural-pseudo'],
    [':scope > div', 'structural-combinator'],
    ['.fresh-agent-layout > .fresh-agent-transcript', 'structural-combinator'],
  ])('denies %s as %s', (selector, code) => {
    expect(classifySelector(selector)).toBe(code)
  })

  it.each([
    '.xterm', // exempt third-party widget root
    '.xterm .xterm-viewport', // exempt widget-root subtree
    '.xterm:visible', // state pseudo is not structure
    '.monaco-editor',
    '[data-context="terminal-pane"]', // data hook — a test contract, not CSS implementation
    '[data-tab-id="abc"]',
    'button[title="Shell"]', // title is an accessible-name source
    'input[aria-label="Search sessions"]',
    'text=Session directory', // user-visible text engine
    'div:has-text("Retry")', // user-visible text
    'iframe[title="Pane browser"]',
  ])('permits %s', (selector) => {
    expect(classifySelector(selector)).toBeNull()
  })
})

describe('scanSource — scanning rules', () => {
  it('does not flag selector-shaped strings inside comments (AST, not regex)', () => {
    const source = [
      "import { test } from '@playwright/test'",
      'test("comment proof", async ({ page }) => {',
      "  // await page.locator('.commented-out')",
      '  /*',
      "   * page.locator('.also-in-a-block-comment')",
      '   */',
      "  const doc = \"docs mention page.locator('.in-a-string-not-a-call')\"",
      '  await page.getByRole(\'button\', { name: \'New shell tab\' }).click()',
      '  void doc',
      '})',
    ].join('\n')
    expect(scanSource(source, 'inline.ts')).toEqual([])
  })

  it('does not flag keyboard input that merely shares a method-name shape', () => {
    const source = [
      "import { test } from '@playwright/test'",
      'test("keyboard", async ({ page }) => {',
      "  await page.keyboard.press('Enter')",
      "  await page.locator('.xterm').first() // exempt widget root",
      '})',
    ].join('\n')
    expect(scanSource(source, 'inline.ts')).toEqual([])
  })

  it('scopes suppression to exactly the annotated line', () => {
    const source = [
      '// a11y-gate: allow -- terminal canvas region, no a11y tree exists',
      "const a = page.locator('.fresh-agent-layout')",
      "const b = page.locator('.fresh-agent-tool-block')",
      "const c = page.locator('.xterm') // a11y-gate: allow -- trailing reason works too",
    ].join('\n')
    const vs = scanSource(source, 'inline.ts').map((v) => v.line)
    expect(vs).toEqual([3]) // line 1's directive suppresses line 2 only; line 4 was self-exempt
  })

  it('a directive without a reason does NOT suppress and is itself a violation', () => {
    const source = [
      '// a11y-gate: allow',
      "const a = page.locator('.fresh-agent-layout')",
      '// a11y-gate: allow -- todo',
      "const b = page.locator('.pane-header-copy')",
    ].join('\n')
    const vs = scanSource(source, 'inline.ts')
    expect(vs.map((v) => `${v.code}@${v.line}`)).toEqual([
      'allow-without-reason@1',
      'css-class@2',
      'allow-without-reason@3',
      'css-class@4',
    ])
  })

  it('records file, line, column, method, and selector on each violation', () => {
    const source = "test(async ({ page }) => {\n  await page.locator('.x-fragile').click()\n})\n"
    const [v] = scanSource(source, 'specs/example.spec.ts')
    expect(v.file).toBe('specs/example.spec.ts')
    expect(v.line).toBe(2)
    expect(v.column).toBeGreaterThan(0)
    expect(v.method).toBe('locator')
    expect(v.selector).toBe('.x-fragile')
  })

  it('handles template-literal selectors without substitutions', () => {
    const vs = scanSource('const l = page.locator(`.with-dot`)', 'inline.ts')
    expect(vs.map((v) => v.code)).toEqual(['css-class'])
  })

  it('ignores template-literal selectors WITH substitutions (dynamic — reviewed by humans)', () => {
    const vs = scanSource('const l = page.locator(`[data-id="${id}"] .row`); const id = 1', 'inline.ts')
    expect(vs).toEqual([])
  })
})

describe('signatureOf / evaluateScan — the warn-turn-deny ratchet', () => {
  const v = (selector: string, code: ViolationCode = 'css-class'): Violation => ({
    file: 'specs/x.spec.ts',
    line: 10,
    column: 9,
    method: 'locator',
    selector,
    code,
    message: 'm',
  })

  it('is line-independent so unrelated edits do not churn the baseline', () => {
    const moved: Violation = { ...v('.a'), line: 999 }
    expect(signatureOf(v('.a'))).toBe(signatureOf(moved))
    expect(signatureOf(v('.a'))).not.toBe(signatureOf(v('.b')))
  })

  it('warn mode always exits 0 and still reports violations', () => {
    const r = evaluateScan([v('.a')], null, 'warn')
    expect(r.exitCode).toBe(0)
    expect(r.report).toMatch(/1 violation/)
  })

  it('deny mode exits 1 on novel violations not in the baseline', () => {
    const baseline: Baseline = { version: 1, files: {} }
    const r = evaluateScan([v('.a')], baseline, 'deny')
    expect(r.exitCode).toBe(1)
    expect(r.novel).toEqual([signatureOf(v('.a'))])
  })

  it('deny mode FAILS CLOSED when no baseline file exists (every violation is novel)', () => {
    const r = evaluateScan([v('.a'), v('.b')], null, 'deny')
    expect(r.exitCode).toBe(1)
    expect(r.novel.length).toBe(2)
    expect(r.report).toMatch(/no baseline/i)
  })

  it('deny mode with no baseline and zero violations exits 0', () => {
    expect(evaluateScan([], null, 'deny').exitCode).toBe(0)
  })

  it('deny mode exits 0 when every violation is baselined', () => {
    const violation = v('.a')
    const baseline: Baseline = {
      version: 1,
      files: { 'specs/x.spec.ts': [signatureOf(violation)] },
    }
    expect(evaluateScan([violation], baseline, 'deny').exitCode).toBe(0)
  })

  it('deny mode exits 1 on stale baseline entries (violation fixed -> ratchet down via --write-baseline)', () => {
    const baseline: Baseline = {
      version: 1,
      files: { 'specs/x.spec.ts': ['locator:css-class:deadbeef'] },
    }
    const r = evaluateScan([], baseline, 'deny')
    expect(r.exitCode).toBe(1)
    expect(r.stale).toEqual(['locator:css-class:deadbeef'])
    expect(r.report).toMatch(/--write-baseline/)
  })

  it('deny mode exits 1 when novel and stale coexist, listing both', () => {
    const baseline: Baseline = {
      version: 1,
      files: { 'specs/x.spec.ts': ['locator:css-class:deadbeef'] },
    }
    const r = evaluateScan([v('.new')], baseline, 'deny')
    expect(r.exitCode).toBe(1)
    expect(r.novel.length).toBe(1)
    expect(r.stale).toEqual(['locator:css-class:deadbeef'])
  })

  it('writeBaseline dedupes identical selector sites to one signature per file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'h11-baseline-'))
    try {
      const site = (line: number): Violation => ({ ...v('..', 'parent-traversal'), line })
      const written = writeBaseline(dir, [site(10), site(20), site(30), v('.unique')])
      expect(written.files['specs/x.spec.ts'].length).toBe(2)
      // ...and the round trip through disk preserves the dedupe.
      const reloaded = readBaseline(dir)
      expect(reloaded).not.toBeNull()
      expect(reloaded!.files['specs/x.spec.ts']).toEqual(written.files['specs/x.spec.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writeBaseline never baselines allow-without-reason (directives must be fixed, not carried)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'h11-baseline-'))
    try {
      const written = writeBaseline(dir, [v('.a'), { ...v('', 'allow-without-reason'), method: 'directive' }])
      expect(written.files['specs/x.spec.ts']).toEqual([signatureOf(v('.a'))])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
