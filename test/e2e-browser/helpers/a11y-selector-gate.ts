import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { SELECTOR_ENGINE_GUIDANCE } from './accessible-interactions.js'

/**
 * HARNESS-11 static accessibility-selector gate.
 *
 * Scans e2e spec sources (TypeScript AST — never regex over raw text, so
 * selector-shaped strings inside comments/strings can never false-positive)
 * and flags locator calls whose raw selector relies on a CSS implementation
 * detail:
 *
 *   - `.class` tokens          -> 'css-class'            (styling is implementation)
 *   - `xpath=` engines          -> 'xpath'
 *   - `..` parent traversal     -> 'parent-traversal'
 *   - `:nth-child`/`:first-child`
 *     style pseudo-classes      -> 'structural-pseudo'   (layout position is implementation)
 *   - `>` child combinators     -> 'structural-combinator'
 *
 * Permitted silently (none are CSS implementation details): `[data-*]` test
 * contracts, `[aria-label=]`/`[title=]` accessible-name sources, `text=` /
 * `:has-text()` user-visible text, `:visible` state, and the documented
 * third-party widget-root exemptions below.
 *
 * Watch-set: `locator` / `frameLocator` ONLY. Survey of the tree (96 specs,
 * 2026-08-09): string-selector convenience forms (`page.click('sel')`,
 * `page.fill`, `page.$`, `waitForSelector`) are never used, while
 * `page.keyboard.press('Enter')` / `locator.press('Enter')` take KEYS as
 * their first string arg — the narrow watch-set is exactly what eliminates
 * those false-positive classes.
 *
 * Escape hatch for genuinely-exempt NEW code (never needed for the baseline,
 * which is carried in `a11y-gate-baseline.json`):
 *
 *   // a11y-gate: allow -- <reason, >= 8 chars>
 *
 * trailing the call line or alone on the immediately preceding line. A
 * directive without a sufficient reason suppresses NOTHING and is itself a
 * violation ('allow-without-reason').
 *
 * Policy / rollout (warn-turn-deny): `docs/plans/df1-evidence/HARNESS-11.md`.
 */

export type ViolationCode =
  | 'css-class'
  | 'xpath'
  | 'parent-traversal'
  | 'structural-pseudo'
  | 'structural-combinator'
  | 'allow-without-reason'

export type Violation = {
  file: string
  line: number
  column: number
  /** e.g. 'locator'; 'directive' for allow-without-reason entries. */
  method: string
  selector: string
  code: ViolationCode
  message: string
}

export type Baseline = {
  version: 1
  /** relative spec-root path -> violation signatures */
  files: Record<string, string[]>
}

export type ScanEvaluation = {
  exitCode: 0 | 1
  report: string
  /** signatures present in the scan but not in the baseline */
  novel: string[]
  /** baseline signatures with no matching violation (ratchet-down signal) */
  stale: string[]
}

/**
 * Third-party widget roots with NO accessibility tree: the terminal canvas
 * and the editor surface. Only these class tokens (and their `-*` subtree
 * classes, e.g. `.xterm-viewport`) may appear in a raw selector.
 */
export const WIDGET_ROOT_EXEMPTIONS = ['xterm', 'monaco-editor'] as const

/** Directories under test/e2e-browser/ scanned by the gate. */
export const SCAN_DIRS = ['specs', 'helpers', 'perf'] as const

export const BASELINE_REL = 'a11y-gate-baseline.json'

const WATCHED_METHODS = new Set(['locator', 'frameLocator'])

const ALLOW_DIRECTIVE = /\/\/\s*a11y-gate:\s*allow(?:\s*--\s*(.*))?$/
const MIN_ALLOW_REASON_LEN = 8

const CLASS_TOKEN = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g
const STRUCTURAL_PSEUDO = /:nth-(?:last-)?(?:child|of-type)\s*\(|:first-child|:last-child|:only-child/

function isExemptWidgetClass(className: string): boolean {
  // `.xterm:visible`'s token arrives as `xterm`; subtree classes like
  // `xterm-viewport` carry the root prefix.
  return WIDGET_ROOT_EXEMPTIONS.some(
    (root) => className === root || className.startsWith(`${root}-`),
  )
}

/**
 * Blank out quoted strings and `[...]` attribute blocks so dots, angles,
 * and pseudo-class-shaped text inside attribute VALUES never confuse the
 * structural checks (e.g. `button[title="A > B"]`).
 */
function blankAttributeValues(selector: string): string {
  let out = ''
  let i = 0
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === '"' || ch === "'") {
      out += ' '
      i++
      while (i < selector.length && selector[i] !== ch) {
        out += ' '
        if (selector[i] === '\\') {
          out += ' ' // blank the escaped char as well
          i += 2
        } else {
          i++
        }
      }
      out += ' '
      i++
    } else if (ch === '[') {
      let depth = 0
      while (i < selector.length) {
        if (selector[i] === '[') depth++
        if (selector[i] === ']') depth--
        out += ' '
        i++
        if (depth === 0) break
      }
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * Classify one raw selector string. Returns the primary violation code, or
 * null when the selector is free of CSS implementation details. Precedence:
 * xpath > parent-traversal > structural-pseudo > structural-combinator >
 * css-class (deterministic; the remediation guidance is identical either way).
 */
export function classifySelector(selector: string): ViolationCode | null {
  const trimmed = selector.trim()
  if (/^xpath\s*=/i.test(trimmed)) return 'xpath'
  if (trimmed === '..' || trimmed.startsWith('../')) return 'parent-traversal'

  // Normalize an explicit `css=` engine prefix; after this point only the
  // selector body is analyzed.
  const body = trimmed.replace(/^css\s*=/i, '')
  const analyzable = blankAttributeValues(body)

  if (STRUCTURAL_PSEUDO.test(analyzable)) return 'structural-pseudo'
  if (analyzable.includes('>')) return 'structural-combinator'

  CLASS_TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CLASS_TOKEN.exec(analyzable)) !== null) {
    if (!isExemptWidgetClass(m[1])) return 'css-class'
  }
  return null
}

const CODE_REMEDIATION: Record<ViolationCode, string> = {
  'css-class':
    'class selectors break when styling changes and carry no user-visible meaning; use byRole(...)/getByRole with an accessible name',
  xpath: 'xpath encodes DOM structure; use byRole(...)/getByRole with an accessible name',
  'parent-traversal': "'..' walks ancestors; select the target by its own role + name",
  'structural-pseudo':
    ':nth-child/:first-child encode layout position; select by role + name (or testid contract)',
  'structural-combinator':
    'the > combinator encodes DOM structure; select the target directly by role + name',
  'allow-without-reason':
    "the allow directive needs a '-- <reason>' (>= 8 chars) so each exemption is auditable",
}

type AllowDirective = { line: number; reason: string | null }

function collectAllowDirectives(sourceText: string): AllowDirective[] {
  const out: AllowDirective[] = []
  const lines = sourceText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = ALLOW_DIRECTIVE.exec(lines[i])
    if (m) {
      out.push({
        line: i + 1,
        reason: m[1] && m[1].trim().length >= MIN_ALLOW_REASON_LEN ? m[1].trim() : null,
      })
    }
  }
  return out
}

function makeViolation(
  file: string,
  line: number,
  column: number,
  method: string,
  selector: string,
  code: ViolationCode,
): Violation {
  return {
    file,
    line,
    column,
    method,
    selector,
    code,
    message:
      `${file}:${line}:${column} — ${code} (${method}('${selector}')): ` +
      `${CODE_REMEDIATION[code]}. ${SELECTOR_ENGINE_GUIDANCE}`,
  }
}

/**
 * Scan one source file's text and return every selector violation.
 * Never throws on unparseable input — a syntax-error file yields the
 * violations findable before the error point, and TypeScript reports the
 * syntax error through its own channel (tsc).
 */
export function scanSource(sourceText: string, fileName: string): Violation[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const directives = collectAllowDirectives(sourceText)
  const allowLines = new Set<number>()
  for (const d of directives) {
    if (d.reason) {
      allowLines.add(d.line) // trailing directive
      allowLines.add(d.line + 1) // preceding-line directive
    }
  }

  const violations: Violation[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WATCHED_METHODS.has(node.expression.name.text)
    ) {
      const first = node.arguments[0]
      let selector: string | null = null
      if (first && ts.isStringLiteral(first)) selector = first.text
      else if (first && ts.isNoSubstitutionTemplateLiteral(first)) selector = first.text
      // Template literals WITH substitutions are dynamic — skipped by design
      // (reviewed by humans, not statically classifiable).
      if (selector !== null) {
        const code = classifySelector(selector)
        if (code) {
          const { line, character } = sf.getLineAndCharacterOfPosition(first.getStart())
          if (!allowLines.has(line + 1)) {
            violations.push(
              makeViolation(fileName, line + 1, character + 1, node.expression.name.text, selector, code),
            )
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Reasonless directives are violations themselves (they look like
  // suppressions but are unauditable) and suppress nothing.
  for (const d of directives) {
    if (!d.reason) {
      const lineStart = sourceText
        .split(/\r?\n/)[d.line - 1].search(/\S/) // first non-space column
      violations.push(
        makeViolation(fileName, d.line, Math.max(1, lineStart + 1), 'directive', '', 'allow-without-reason'),
      )
    }
  }

  violations.sort((a, b) => a.line - b.line || a.column - b.column)
  return violations
}

/** Line-independent baseline signature: survives unrelated edits in the file. */
export function signatureOf(v: Pick<Violation, 'method' | 'code' | 'selector'>): string {
  const hash = crypto.createHash('sha1').update(v.selector).digest('hex').slice(0, 8)
  return `${v.method}:${v.code}:${hash}`
}

/** Files the gate never scans: probe fixtures, its own implementation, tests. */
const SELF_EXCLUSIONS = new Set([
  path.normalize('helpers/a11y-selector-gate.ts'),
  path.normalize('helpers/a11y-selector-gate-cli.ts'),
])

export function collectScanFiles(rootDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const rel = path.normalize(path.relative(rootDir, full))
      if (SELF_EXCLUSIONS.has(rel)) continue
      out.push(full)
    }
  }
  for (const dir of SCAN_DIRS) {
    const abs = path.join(rootDir, dir)
    if (fs.existsSync(abs)) walk(abs)
  }
  return out.sort()
}

export function scanTree(rootDir: string): Violation[] {
  const violations: Violation[] = []
  for (const file of collectScanFiles(rootDir)) {
    violations.push(...scanSource(fs.readFileSync(file, 'utf8'), path.relative(rootDir, file)))
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}

export function baselinePath(rootDir: string): string {
  return path.join(rootDir, BASELINE_REL)
}

export function readBaseline(rootDir: string): Baseline | null {
  const p = baselinePath(rootDir)
  if (!fs.existsSync(p)) return null
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Baseline
  if (parsed.version !== 1 || typeof parsed.files !== 'object') {
    throw new Error(`${p}: unsupported baseline shape (expected {version:1, files:{...}})`)
  }
  return parsed
}

export function writeBaseline(rootDir: string, violations: Violation[]): Baseline {
  const files: Record<string, string[]> = {}
  for (const v of violations) {
    if (v.code === 'allow-without-reason') continue // directives must be fixed, never baselined
    ;(files[v.file] ??= []).push(signatureOf(v))
  }
  // Dedupe per file: N identical selector SITES (e.g. five `locator('..')` in
  // one spec) collapse to ONE stored signature — the baseline tracks distinct
  // violation SHAPES per file, and the deny report above still counts sites.
  // Consequence (documented): removing SOME-but-not-all identical sites does
  // not ratchet; the shape goes stale only when its last site disappears.
  for (const key of Object.keys(files)) files[key] = [...new Set(files[key])].sort()
  const baseline: Baseline = {
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  }
  fs.writeFileSync(baselinePath(rootDir), JSON.stringify(baseline, null, 2) + '\n')
  return baseline
}

/**
 * Warn-turn-deny evaluation.
 *
 * - `warn`: always exit 0; full report (the campaign-wide rollout mode — the
 *   baseline enumeration stands in for a mass rewrite).
 * - `deny`: exit 1 when the scan differs from the baseline in EITHER
 *   direction: novel signatures (new violations — the gate biting) or stale
 *   baseline entries (a violation was fixed — ratchet down by re-running
 *   `--write-baseline` and committing the smaller file).
 */
export function evaluateScan(
  violations: Violation[],
  baseline: Baseline | null,
  mode: 'warn' | 'deny',
): ScanEvaluation {
  const byFile = new Map<string, Violation[]>()
  for (const v of violations) {
    const list = byFile.get(v.file) ?? []
    list.push(v)
    byFile.set(v.file, list)
  }

  // novel/stale carry bare signatures (the programmatic contract); the
  // report renders them file-qualified for humans. FAIL-CLOSED: a missing
  // baseline in deny mode makes every violation novel — a gate whose
  // baseline file vanished must not silently pass.
  const effectiveBaseline: Baseline = baseline ?? { version: 1, files: {} }
  const novelSigs: string[] = []
  const novelLines: string[] = []
  for (const v of violations) {
    const sig = signatureOf(v)
    if (!(effectiveBaseline.files[v.file] ?? []).includes(sig)) {
      novelSigs.push(sig)
      novelLines.push(`${v.file} -> ${sig}`)
    }
  }
  const staleSigs: string[] = []
  const staleLines: string[] = []
  {
    const liveByFile = new Map<string, Set<string>>()
    for (const v of violations) {
      const set = liveByFile.get(v.file) ?? new Set<string>()
      set.add(signatureOf(v))
      liveByFile.set(v.file, set)
    }
    for (const [file, sigs] of Object.entries(effectiveBaseline.files)) {
      const live = liveByFile.get(file) ?? new Set<string>()
      for (const sig of sigs) {
        if (!live.has(sig)) {
          staleSigs.push(sig)
          staleLines.push(`${file} -> ${sig}`)
        }
      }
    }
  }

  const lines: string[] = []
  const total = violations.length
  const codeCounts = new Map<ViolationCode, number>()
  for (const v of violations) codeCounts.set(v.code, (codeCounts.get(v.code) ?? 0) + 1)
  const codeSummary = [...codeCounts.entries()].map(([c, n]) => `${c}:${n}`).join(', ')
  lines.push(
    `a11y selector gate (${mode}): ${total} violation${total === 1 ? '' : 's'} across ${byFile.size} file(s)` +
      (total ? ` [${codeSummary}]` : ''),
  )
  for (const [file, vs] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${file} (${vs.length})`)
    for (const v of vs) lines.push(`    L${v.line}:${v.column} ${v.code} — ${v.method}('${v.selector}')`)
  }

  let exitCode: 0 | 1 = 0
  if (mode === 'deny') {
    if (baseline === null && violations.length > 0) {
      lines.push(
        'NO BASELINE FILE — fail-closed: every violation below is treated as novel. ' +
          'Create one deliberately with --write-baseline.',
      )
    }
    if (novelSigs.length > 0 || staleSigs.length > 0) {
      exitCode = 1
      if (novelSigs.length > 0) {
        lines.push(`NOVEL violations (not in baseline): ${novelSigs.length}`)
        for (const n of novelLines) lines.push(`  ${n}`)
      }
      if (staleSigs.length > 0) {
        lines.push(
          `STALE baseline entries (violation fixed — ratchet down): ${staleSigs.length}. ` +
            'Re-run with --write-baseline and commit the smaller baseline.',
        )
        for (const s of staleLines) lines.push(`  ${s}`)
      }
    } else {
      lines.push('deny: scan matches baseline — no novel violations, no stale entries.')
    }
  }

  return { exitCode, report: lines.join('\n'), novel: novelSigs, stale: staleSigs }
}
