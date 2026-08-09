/**
 * GATE-01 — fold Playwright JSON reports into the committed baseline
 * artifact `test/e2e-browser/gate01-baseline.json`, and apply attribution
 * judgments on top (attributions are never clobbered by later merges).
 *
 * Suite definition (the "unchanged legacy browser suite"): every
 * test/e2e-browser/specs/*.spec.ts EXCEPT playwright.config.ts's
 * RUST_ONLY_SPECS — enumerated AT COLLATOR LOAD TIME from disk + the base
 * config's own exported array, so the baseline can never silently drift from
 * the actual chromium-lane selection.
 *
 * CLI (tsx):
 *   tsx gate01-collate.ts init     --head <sha> --bin-sha <sha256> [--baseline path]
 *   tsx gate01-collate.ts merge    --report <pw-json> --run <slice-id> [--baseline path] [--head sha]
 *   tsx gate01-collate.ts attribute --spec <file> --leg legacy|rust
 *        (--kind gap --owner ITEM-ID | --kind gap-unscoped | --kind flake --reproof r1,r2
 *         | --kind known-flake --ref <text> | --kind preexisting --ref <text>)
 *        [--verdict v] [--note text] [--baseline path]
 *   tsx gate01-collate.ts tally [--baseline path]   (print per-leg verdict counts; exit 1 if any pending)
 *
 * Bucket rule: specs starting with `harness-` are bucket=harness (campaign
 * harness self-checks); everything else is bucket=product.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUST_ONLY_SPECS } from '../playwright.config.js'

export const SUITE_SPEC_COUNT = 69

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_BASELINE = path.resolve(__dirname, '..', 'gate01-baseline.json')
const SPECS_DIR = path.resolve(__dirname, '..', 'specs')

export type Gate01Leg = 'legacy' | 'rust'
export type Gate01Verdict =
  | 'pending'
  | 'pass'
  | 'fail'
  | 'skip-all'
  | 'flaky-reproven'

export interface Gate01Failure {
  title: string
  line: number
  error: string
}

export interface Gate01Attribution {
  kind: 'gap' | 'gap-unscoped' | 'flake' | 'known-flake' | 'preexisting'
  owner?: string
  reproof?: string[]
  ref?: string
  note?: string
}

export interface Gate01RunTally {
  run: string
  passed: number
  failed: number
  skipped: number
  expectedFail: number
  durationMs: number
}

export interface Gate01LegResult {
  verdict: Gate01Verdict
  /** Counters of the LATEST run touching this leg (replaced per run, never summed). */
  passed: number
  failed: number
  skipped: number
  expectedFail: number
  durationMs: number
  /** Run ids in order, one entry per run that touched this leg. */
  runs: string[]
  /** Per-run tallies, so re-runs (flake reproofs, isolated re-readings) keep history. */
  runHistory: Gate01RunTally[]
  /** Failure details of the LATEST run that had failures (emptied by a clean re-run). */
  failures: Gate01Failure[]
  attribution: Gate01Attribution | null
}

export interface Gate01Baseline {
  schema: 1
  item: 'GATE-01'
  generatedBy: string
  head: string
  rustServerBinSha256: string
  suiteDefinition: {
    selector: string
    specCount: number
    rustOnlyExcluded: string[]
  }
  specs: Record<string, { bucket: 'product' | 'harness'; legs: Record<Gate01Leg, Gate01LegResult> }>
}

// ---- Playwright 1.58 JSON reporter structural typing (only what we read) ----

export interface PlaywrightJsonReport {
  suites: PwSuite[]
  errors: unknown[]
  stats: Record<string, unknown>
}
interface PwSuite {
  title: string
  file?: string
  specs?: PwSpec[]
  suites?: PwSuite[]
}
interface PwSpec {
  title: string
  file: string
  line: number
  tests: PwTest[]
}
interface PwTest {
  projectName: string
  annotations?: { type: string; description?: string }[]
  status: string // 'expected' | 'unexpected' | 'flaky' | 'skipped'
  results: { status: string; duration: number; errors?: { message?: string }[] }[]
}

/** Regex sources from RUST_ONLY_SPECS, e.g. /foo\.spec\.ts$/ -> foo.spec.ts */
function rustOnlyFileNames(): string[] {
  return RUST_ONLY_SPECS.map((re) => re.source.replace(/\\/g, '').replace(/\$$/, ''))
}

/** The suite: every *.spec.ts on disk minus RUST_ONLY_SPECS. Sorted. */
export function suiteSpecList(): Record<string, 'product' | 'harness'> {
  const excluded = new Set(rustOnlyFileNames())
  const files = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.spec.ts') && !excluded.has(f))
    .sort()
  const out: Record<string, 'product' | 'harness'> = {}
  for (const f of files) out[f] = f.startsWith('harness-') ? 'harness' : 'product'
  return out
}

function emptyLeg(): Gate01LegResult {
  return {
    verdict: 'pending',
    passed: 0,
    failed: 0,
    skipped: 0,
    expectedFail: 0,
    durationMs: 0,
    runs: [],
    runHistory: [],
    failures: [],
    attribution: null,
  }
}

export function emptyBaseline(
  head: string,
  specs: Record<string, 'product' | 'harness'>,
  rustServerBinSha256: string,
): Gate01Baseline {
  const specEntries: Gate01Baseline['specs'] = {}
  for (const [file, bucket] of Object.entries(specs)) {
    specEntries[file] = { bucket, legs: { legacy: emptyLeg(), rust: emptyLeg() } }
  }
  return {
    schema: 1,
    item: 'GATE-01',
    generatedBy: 'test/e2e-browser/helpers/gate01-collate.ts',
    head,
    rustServerBinSha256,
    suiteDefinition: {
      selector:
        'test/e2e-browser/specs/**/*.spec.ts minus RUST_ONLY_SPECS (the chromium project test selection, playwright.config.ts)',
      specCount: Object.keys(specEntries).length,
      rustOnlyExcluded: rustOnlyFileNames().sort(),
    },
    specs: specEntries,
  }
}

function verdictFor(leg: Gate01LegResult): Gate01Verdict {
  if (leg.failed > 0) return 'fail'
  if (leg.passed === 0 && leg.expectedFail === 0 && leg.skipped > 0) return 'skip-all'
  if (leg.passed === 0 && leg.expectedFail === 0 && leg.skipped === 0) return 'pending'
  return 'pass'
}

function* walkSpecs(suite: PwSuite): Generator<PwSpec> {
  for (const s of suite.specs ?? []) yield s
  for (const child of suite.suites ?? []) yield* walkSpecs(child)
}

export function mergeReport(
  baseline: Gate01Baseline,
  report: PlaywrightJsonReport,
  runId: string,
): Gate01Baseline {
  for (const fileSuite of report.suites) {
    const file = path.basename(fileSuite.file ?? fileSuite.title)
    const entry = baseline.specs[file]
    if (!entry) {
      throw new Error(
        `report contains spec file ${file} which is outside the GATE-01 suite definition`,
      )
    }
    // Pass 1: compute THIS run's tally per leg from the report.
    const tally: Record<Gate01Leg, Gate01RunTally> = {
      legacy: { run: runId, passed: 0, failed: 0, skipped: 0, expectedFail: 0, durationMs: 0 },
      rust: { run: runId, passed: 0, failed: 0, skipped: 0, expectedFail: 0, durationMs: 0 },
    }
    const failures: Record<Gate01Leg, Gate01Failure[]> = { legacy: [], rust: [] }
    for (const spec of walkSpecs(fileSuite)) {
      for (const t of spec.tests) {
        const legKey: Gate01Leg = t.projectName === 'gate01-rust' ? 'rust' : 'legacy'
        const leg = tally[legKey]
        const isExpectedFail = (t.annotations ?? []).some((a) => a.type === 'fail')
        leg.durationMs += (t.results ?? []).reduce((n, r) => n + (r.duration || 0), 0)
        if (t.status === 'skipped') {
          leg.skipped += 1
        } else if (t.status === 'unexpected') {
          leg.failed += 1
          const err = t.results?.flatMap((r) => r.errors ?? []).find((e) => e.message)?.message ?? ''
          failures[legKey].push({
            title: spec.title,
            line: spec.line,
            error: String(err).split('\n').slice(0, 12).join('\n').slice(0, 1200),
          })
        } else if (isExpectedFail) {
          leg.expectedFail += 1
        } else if (t.status === 'expected') {
          leg.passed += 1
        } else {
          // 'flaky' (should not occur with retries=0) — count as failed so it
          // can never hide; attribution must resolve it.
          leg.failed += 1
          failures[legKey].push({ title: spec.title, line: spec.line, error: `flaky status reported: ${t.status}` })
        }
      }
    }
    // Pass 2: replace per-leg counters with this run's tally (idempotent
    // re-runs), append history, recompute the mechanical verdict, and never
    // clobber an existing attribution.
    for (const legKey of ['legacy', 'rust'] as const) {
      const t = tally[legKey]
      const exercised = t.passed + t.failed + t.skipped + t.expectedFail > 0
      if (!exercised) continue
      const leg = entry.legs[legKey]
      leg.passed = t.passed
      leg.failed = t.failed
      leg.skipped = t.skipped
      leg.expectedFail = t.expectedFail
      leg.durationMs = t.durationMs
      if (!leg.runs.includes(runId)) leg.runs.push(runId)
      leg.runHistory.push(t)
      leg.failures = failures[legKey]
      if (!leg.attribution) leg.verdict = verdictFor(leg)
      else if (leg.attribution.kind === 'gap' || leg.attribution.kind === 'gap-unscoped') leg.verdict = 'fail'
      else if (leg.attribution.kind === 'flake') leg.verdict = 'flaky-reproven'
    }
  }
  return baseline
}

export function applyAttribution(
  baseline: Gate01Baseline,
  spec: string,
  legKey: Gate01Leg,
  attribution: Gate01Attribution & { verdict?: Gate01Verdict },
): Gate01Baseline {
  const entry = baseline.specs[spec]
  if (!entry) throw new Error(`unknown spec ${spec}`)
  const leg = entry.legs[legKey]
  leg.attribution = {
    kind: attribution.kind,
    ...(attribution.owner ? { owner: attribution.owner } : {}),
    ...(attribution.reproof ? { reproof: attribution.reproof } : {}),
    ...(attribution.ref ? { ref: attribution.ref } : {}),
    ...(attribution.note ? { note: attribution.note } : {}),
  }
  if (attribution.kind === 'flake') leg.verdict = 'flaky-reproven'
  else if (attribution.kind === 'gap' || attribution.kind === 'gap-unscoped') leg.verdict = 'fail'
  else if (attribution.verdict) leg.verdict = attribution.verdict
  return baseline
}

export function tallyVerdicts(baseline: Gate01Baseline) {
  const tally: Record<Gate01Leg, Record<Gate01Verdict, number>> = {
    legacy: { pending: 0, pass: 0, fail: 0, 'skip-all': 0, 'flaky-reproven': 0 },
    rust: { pending: 0, pass: 0, fail: 0, 'skip-all': 0, 'flaky-reproven': 0 },
  }
  const gaps: { spec: string; leg: Gate01Leg; owner: string }[] = []
  for (const [spec, entry] of Object.entries(baseline.specs)) {
    for (const legKey of ['legacy', 'rust'] as const) {
      const leg = entry.legs[legKey]
      tally[legKey][leg.verdict] += 1
      if (leg.attribution && (leg.attribution.kind === 'gap' || leg.attribution.kind === 'gap-unscoped')) {
        gaps.push({ spec, leg: legKey, owner: leg.attribution.owner ?? 'UNSCOPED' })
      }
    }
  }
  return { ...tally, gaps }
}

// ---------------- CLI ----------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

function loadBaseline(p: string): Gate01Baseline {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Gate01Baseline
}

function saveBaseline(p: string, b: Gate01Baseline): void {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const baselinePath = path.resolve(args.baseline ?? DEFAULT_BASELINE)

  if (cmd === 'init') {
    const specs = suiteSpecList()
    const b = emptyBaseline(args.head ?? 'unknown', specs, args['bin-sha'] ?? 'unknown')
    saveBaseline(baselinePath, b)
    console.log(`initialized ${baselinePath} with ${Object.keys(specs).length} specs`)
    return
  }
  if (cmd === 'merge') {
    const report = JSON.parse(fs.readFileSync(path.resolve(args.report), 'utf8')) as PlaywrightJsonReport
    const b = loadBaseline(baselinePath)
    if (args.head) b.head = args.head
    if (args['bin-sha']) b.rustServerBinSha256 = args['bin-sha']
    mergeReport(b, report, args.run ?? 'run')
    saveBaseline(baselinePath, b)
    const t = tallyVerdicts(b)
    console.log(`merged ${args.report} (run=${args.run})`)
    console.log(`legacy: ${JSON.stringify(t.legacy)}  rust: ${JSON.stringify(t.rust)}`)
    return
  }
  if (cmd === 'attribute') {
    const b = loadBaseline(baselinePath)
    const kind = args.kind as Gate01Attribution['kind']
    applyAttribution(b, args.spec, args.leg as Gate01Leg, {
      kind,
      owner: args.owner,
      reproof: args.reproof ? args.reproof.split(',') : undefined,
      ref: args.ref,
      note: args.note,
      verdict: args.verdict as Gate01Verdict | undefined,
    })
    saveBaseline(baselinePath, b)
    console.log(`attributed ${args.spec} [${args.leg}] kind=${kind}${args.owner ? ' owner=' + args.owner : ''}`)
    return
  }
  if (cmd === 'tally') {
    const b = loadBaseline(baselinePath)
    const t = tallyVerdicts(b)
    console.log(JSON.stringify(t, null, 2))
    if (t.legacy.pending > 0 || t.rust.pending > 0) process.exit(1)
    return
  }
  throw new Error(`unknown command ${cmd}; expected init|merge|attribute|tally`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
