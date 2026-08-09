import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  baselinePath,
  evaluateScan,
  readBaseline,
  scanTree,
  writeBaseline,
} from './a11y-selector-gate.js'

/**
 * HARNESS-11 a11y selector gate CLI.
 *
 *   tsx test/e2e-browser/helpers/a11y-selector-gate-cli.ts [--warn|--deny] [--write-baseline] [--json]
 *
 * - `--warn` (default): scan the tree, print the grouped report, exit 0.
 *   The rollout mode: existing violations are reported, never rewritten.
 * - `--deny`: exit 1 when the scan differs from the committed baseline in
 *   either direction (novel violations bite; fixed violations must be
 *   ratcheted down via --write-baseline).
 * - `--write-baseline`: rewrite `a11y-gate-baseline.json` from the current
 *   scan and print the delta. `--deny` composes with it (rewrite, then deny
 *   evaluates against the fresh baseline).
 * - `--json`: machine-readable summary instead of the human report.
 *
 * The gate needs no server and no Playwright browser — it is pure static
 * analysis, so it runs without the pw/cargo leases.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TREE_ROOT = path.resolve(__dirname, '..')

function main(argv: string[]): number {
  const flags = new Set(argv.slice(2))
  const mode = flags.has('--deny') ? ('deny' as const) : ('warn' as const)
  const asJson = flags.has('--json')

  let violations = scanTree(TREE_ROOT)

  if (flags.has('--write-baseline')) {
    const previous = readBaseline(TREE_ROOT)
    const prevCount = previous
      ? Object.values(previous.files).reduce((n, sigs) => n + sigs.length, 0)
      : 0
    const next = writeBaseline(TREE_ROOT, violations)
    const nextCount = Object.values(next.files).reduce((n, sigs) => n + sigs.length, 0)
    console.log(
      `baseline rewritten at ${path.relative(process.cwd(), baselinePath(TREE_ROOT))}: ` +
        `${prevCount} -> ${nextCount} violation signature(s)`,
    )
  }

  const baseline = readBaseline(TREE_ROOT)
  const evaluation = evaluateScan(violations, baseline, mode)

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          mode,
          exitCode: evaluation.exitCode,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            code: v.code,
            method: v.method,
            selector: v.selector,
          })),
          novel: evaluation.novel,
          stale: evaluation.stale,
          baselinePresent: baseline !== null,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(evaluation.report)
    if (mode === 'warn' && violations.length > 0) {
      console.log(
        '\nwarn mode: reported only, exit 0. Enforcement: run with --deny ' +
          '(fails on novel violations vs a11y-gate-baseline.json). ' +
          'Fix a violation? Ratchet down with --write-baseline and commit the smaller baseline.',
      )
    }
  }

  return evaluation.exitCode
}

process.exit(main(process.argv))
