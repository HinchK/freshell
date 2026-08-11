import { defineConfig, devices } from '@playwright/test'
import baseConfig, { RUST_ONLY_SPECS } from './playwright.config'

/**
 * GATE-01 — run the UNCHANGED legacy browser suite against BOTH server kinds.
 *
 * "The unchanged legacy browser suite" is the effective test selection of the
 * `chromium` project in ./playwright.config.ts: every specs/ *.spec.ts file
 * EXCEPT RUST_ONLY_SPECS (the chromium project's testIgnore — those specs
 * hard-fail under legacy by design, see their per-entry comments). This
 * config changes NO selection semantics: it imports the SAME RUST_ONLY_SPECS
 * array as testIgnore and inherits everything else from the base config.
 *
 * It exists because positional CLI file filters can only NARROW a project's
 * testMatch (so the 28-file MATRIX_SPECS of `legacy-chromium`/`rust-chromium`
 * cannot be widened from the CLI). The base config's own MATRIX_SPECS comment
 * anticipates "a broader `testMatch` override" for exactly this verification.
 *
 * The two gate projects differ ONLY in the `e2eServerKind` worker option
 * (helpers/fixtures.ts): gate01-legacy boots the Node TestServer,
 * gate01-rust boots the owned RustServer. All conditional annotations keyed
 * on `e2eServerKind` (test.fail/test.skip) behave exactly as they do in the
 * matrix projects — they read the option, not the project name.
 *
 * snapshotPathTemplate pins the project-name snapshot segment to the literal
 * `chromium` token so BOTH legs compare against the SAME committed visual
 * baselines (`<arg>-chromium-<platform>.png`) — the checklist's "committed
 * visual baselines pass for both" requirement.
 *
 * Run protocol, suite definition, and attribution rules:
 * docs/plans/df1/GATE-01.md. Results: test/e2e-browser/gate01-baseline.json +
 * docs/plans/df1-evidence/GATE-01.md.
 *
 * Rust binary: set FRESHELL_E2E_RUST_SERVER_BIN to a pre-built
 * target/release/freshell-server (helpers/rust-server.ts's fail-closed
 * override seam) so no implicit cargo build fires inside Playwright workers
 * under the pw lease. Rebuild that binary first if this branch is ever
 * rebased onto changed rust sources.
 */

const jsonOutput = process.env.GATE01_JSON_OUTPUT

export default defineConfig({
  ...baseConfig,
  // Both legs compare screenshots against the SAME committed `chromium`
  // baselines (see header comment). NB: `{snapshotDir}/{testFilePath}` is the
  // pair that reproduces the default on-disk `-snapshots` layout — using
  // `{testFileDir}/{testFileName}` resolves to the EMPTY string + bare name
  // for specs sitting directly in testDir, which broke with EACCES mkdir
  // '/<spec>-snapshots' in the first slice-0 attempt.
  snapshotPathTemplate:
    '{snapshotDir}/{testFilePath}-snapshots/{arg}-chromium-{platform}{ext}',
  // Keep human progress on the console AND emit a machine-readable report
  // when the runner asks for one (GATE01_JSON_OUTPUT is per-slice).
  reporter: jsonOutput
    ? [['list'], ['json', { outputFile: jsonOutput }]]
    : baseConfig.reporter,
  projects: [
    {
      name: 'gate01-legacy',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'legacy' as const },
      testIgnore: RUST_ONLY_SPECS,
    },
    {
      name: 'gate01-rust',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'rust' as const },
      testIgnore: RUST_ONLY_SPECS,
    },
  ],
})
