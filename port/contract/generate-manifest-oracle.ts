/**
 * Freeze the legacy extension-manifest validator's behavior as a
 * language-neutral oracle artifact (df1 EXT-01).
 *
 * This generator drives the SINGLE source of truth — the UNMODIFIED legacy
 * zod-4 schema in `server/extension-manifest.ts` — through the exact legacy
 * flow (`JSON.parse(rawText)` → `ExtensionManifestSchema.safeParse(json)`)
 * over a pinned case list, and emits one committed, deterministic file:
 *
 *   crates/freshell-extensions/fixtures/manifest-oracle.json
 *
 * Each row captures the FULL observable contract for one manifest input:
 *   - rawText:      the exact freshell.json file text (covers duplicate keys
 *                   and JS number parsing — both sides consume text)
 *   - expected.success / expected.parseError:
 *                   accept/reject verdict (parseError = legacy's
 *                   'invalid JSON in manifest' class, JSON.parse threw)
 *   - expected.data:    zod's output WITH defaults materialized
 *                       (server.args=[], server.readyTimeout=10000,
 *                       server.singleton=true, cli.args=[])
 *   - expected.issues:  flattened [{code, path, message}] — zod 4.4.3 issue
 *                       text byte-for-byte, in zod's emission order
 *
 * The Rust `freshell-extensions` crate's `tests/oracle.rs` iterates this
 * fixture and asserts equality — a differential oracle, not a hand-copy.
 *
 * Run: `npx tsx port/contract/generate-manifest-oracle.ts` from the repo root.
 * Output is deterministic for a given `server/extension-manifest.ts` + zod
 * version: re-running must produce a byte-identical file (the df1 Task-1
 * hermiticity gate). Regenerate after ANY change to the legacy schema or a
 * zod bump, and land the fixture diff in the same commit.
 *
 * DO NOT edit the emitted JSON by hand. DO NOT edit rows to match Rust — the
 * legacy schema is the oracle; fix the Rust port instead.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionManifestSchema } from '../../server/extension-manifest.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Repository root (this file lives at `<root>/port/contract/`). */
const REPO_ROOT = path.resolve(__dirname, '../..')
/** Committed oracle fixture consumed by crates/freshell-extensions/tests/oracle.rs. */
const ORACLE_PATH = path.join(
  REPO_ROOT,
  'crates',
  'freshell-extensions',
  'fixtures',
  'manifest-oracle.json',
)

/** zod version that produced the fixture (drift signal on bumps). */
const ZOD_VERSION: string = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'node_modules', 'zod', 'package.json'), 'utf8'),
).version

// ──────────────────────────────────────────────────────────────
// Case model
// ──────────────────────────────────────────────────────────────

interface Issue {
  code: string
  path: (string | number)[]
  message: string
}

interface Expected {
  success: boolean
  /** Present only when JSON.parse itself throws (legacy 'invalid JSON' class). */
  parseError?: boolean
  data?: unknown
  issues?: Issue[]
}

interface OracleCase {
  name: string
  rawText: string
  expected: Expected
}

/** Run the EXACT legacy flow for one manifest file text. */
function judge(rawText: string): Expected {
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    return { success: false, parseError: true }
  }
  const result = ExtensionManifestSchema.safeParse(json)
  if (result.success) {
    // JSON round-trip elides undefined-valued optional keys, byte-matching
    // what a client of `result.data` observes over the wire.
    return { success: true, data: JSON.parse(JSON.stringify(result.data)) }
  }
  return {
    success: false,
    issues: result.error.issues.map((i) => ({
      code: i.code,
      path: i.path as (string | number)[],
      message: i.message,
    })),
  }
}

/** Synthetic case from a JS value (serialized deterministically below). */
function synth(name: string, input: unknown): { name: string; rawText: string } {
  return { name, rawText: JSON.stringify(input) }
}

// ──────────────────────────────────────────────────────────────
// Baselines (mirror test/unit/server/extension-manifest.test.ts fixtures)
// ──────────────────────────────────────────────────────────────

const validServerManifest = {
  name: 'test-server-ext',
  version: '0.1.0',
  label: 'Test Server Extension',
  description: 'A test server extension',
  category: 'server' as const,
  server: {
    command: 'node',
    args: ['dist/index.js'],
    readyPattern: 'Listening on',
    readyTimeout: 10000,
    singleton: true,
  },
}

const validClientManifest = {
  name: 'test-client-ext',
  version: '1.0.0',
  label: 'Test Client Extension',
  description: 'A test client extension',
  category: 'client' as const,
  client: {
    entry: './dist/index.html',
  },
}

const validCliManifest = {
  name: 'test-cli-ext',
  version: '0.2.0',
  label: 'Test CLI Extension',
  description: 'A test CLI extension',
  category: 'cli' as const,
  cli: {
    command: 'lazygit',
  },
}

// ──────────────────────────────────────────────────────────────
// The case list (fixed order = fixture order; append-only by convention)
// ──────────────────────────────────────────────────────────────

const cases: { name: string; rawText: string }[] = [
  // ── A. Valid manifests ──
  synth('valid-server-manifest', validServerManifest),
  synth('valid-client-manifest', validClientManifest),
  synth('valid-cli-manifest', validCliManifest),
  synth('cli-full-launch-templates-and-permission-mapping', {
    ...validCliManifest,
    cli: {
      command: 'opencode',
      resumeArgs: ['--session', '{{sessionId}}'],
      createSessionArgs: ['--session-id', '{{sessionId}}'],
      modelArgs: ['--model', '{{model}}'],
      sandboxArgs: ['--sandbox', '{{sandbox}}'],
      permissionModeArgs: ['--permission-mode', '{{permissionMode}}'],
      permissionModeEnvVar: 'AGENT_PERMISSION_MODE',
      permissionModeValues: {
        plan: '{"edit":"ask","bash":"ask"}',
      },
      supportsPermissionMode: true,
      supportsModel: true,
      supportsSandbox: true,
    },
  }),
  synth('optional-fields-icon-url-contentschema-picker', {
    ...validServerManifest,
    icon: './icon.svg',
    url: '/run/{{runId}}',
    contentSchema: {
      runId: { type: 'string', label: 'Run ID', required: true },
    },
    picker: { shortcut: 'K', group: 'tools' },
  }),
  synth('picker-shortcut-only', { ...validClientManifest, picker: { shortcut: 'C' } }),
  synth('picker-group-only', { ...validClientManifest, picker: { group: 'viewers' } }),
  synth('picker-empty-object', { ...validClientManifest, picker: {} }),
  synth('server-env-template-vars', {
    ...validServerManifest,
    server: { ...validServerManifest.server, env: { PORT: '{{port}}', RUNS_DIR: '{{runsDir}}' } },
  }),
  synth('server-health-check', {
    ...validServerManifest,
    server: { ...validServerManifest.server, healthCheck: '/api/health' },
  }),
  synth('server-singleton-explicit-false', {
    ...validServerManifest,
    server: { ...validServerManifest.server, singleton: false },
  }),
  // Defaults materialize: args=[] + readyTimeout=10000 + singleton=true.
  synth('server-defaults-materialize', {
    ...validServerManifest,
    server: { command: 'node', args: ['dist/index.js'], readyPattern: 'Listening' },
  }),
  synth('server-args-default-empty', {
    ...validServerManifest,
    server: { command: 'node' },
  }),
  synth('cli-args-default-empty', validCliManifest),
  synth('cli-args-and-env', {
    ...validCliManifest,
    cli: { command: 'htop', args: ['-d', '10'], env: { TERM: 'xterm-256color' } },
  }),
  synth('contentschema-all-three-field-types', {
    ...validClientManifest,
    contentSchema: {
      name: { type: 'string', label: 'Name', required: true },
      count: { type: 'number', label: 'Count', default: 5 },
      verbose: { type: 'boolean', label: 'Verbose', default: false },
    },
  }),
  synth('contentschema-string-default', {
    ...validClientManifest,
    contentSchema: { dir: { type: 'string', label: 'Directory', default: '/tmp' } },
  }),
  synth('contentschema-empty-record', { ...validClientManifest, contentSchema: {} }),
  synth('contentschema-number-float-default', {
    ...validClientManifest,
    contentSchema: { ratio: { type: 'number', label: 'Ratio', default: 1.5 } },
  }),
  // Bare z.string() fields: EMPTY STRING IS VALID (no min(1)).
  synth('empty-icon-string-valid', { ...validServerManifest, icon: '' }),
  synth('empty-url-string-valid', { ...validClientManifest, url: '' }),
  synth('cli-empty-envvar-valid', {
    ...validCliManifest,
    cli: { command: 'htop', envVar: '' },
  }),
  synth('server-empty-readypattern-valid', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyPattern: '' },
  }),
  synth('server-empty-healthcheck-valid', {
    ...validServerManifest,
    server: { ...validServerManifest.server, healthCheck: '' },
  }),
  synth('picker-empty-shortcut-valid', { ...validClientManifest, picker: { shortcut: '' } }),
  // Whitespace-only name passes min(1) (length 1).
  synth('name-whitespace-valid', { ...validCliManifest, name: ' ' }),
  synth('args-empty-string-element-valid', {
    ...validCliManifest,
    cli: { command: 'htop', args: [''] },
  }),
  synth('terminalbehavior-both-fields', {
    ...validCliManifest,
    cli: {
      command: 'opencode',
      terminalBehavior: {
        preferredRenderer: 'canvas',
        scrollInputPolicy: 'fallbackToCursorKeysWhenAltScreenMouseCapture',
      },
    },
  }),
  synth('terminalbehavior-scroll-input-policy-native', {
    ...validCliManifest,
    cli: { command: 'opencode', terminalBehavior: { scrollInputPolicy: 'native' } },
  }),
  synth('terminalbehavior-empty-object', {
    ...validCliManifest,
    cli: { command: 'opencode', terminalBehavior: {} },
  }),
  synth('server-readytimeout-max-safe-int', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: 9007199254740991 },
  }),

  // ── B. Duplicate JSON keys: last wins (JSON.parse semantics — the Rust
  // port must parse text to Value, not derive-Deserialize, to match) ──
  {
    name: 'duplicate-name-key-last-wins',
    rawText:
      '{ "name": "first-name", "name": "second-name", "version": "1.0.0", "label": "L", "description": "D", "category": "cli", "cli": { "command": "x" } }',
  },

  // ── C. Invalid JSON text (legacy 'invalid JSON in manifest' warn class) ──
  { name: 'invalid-json-text', rawText: '{ "name": "x", ' },

  // ── D. Required-field failures ──
  synth('missing-most-required-fields', { name: 'x' }),
  synth('empty-name', { ...validServerManifest, name: '' }),
  synth('empty-version', { ...validServerManifest, version: '' }),
  synth('empty-label', { ...validServerManifest, label: '' }),
  synth('empty-description', { ...validServerManifest, description: '' }),
  synth('name-wrong-type-number', { ...validServerManifest, name: 5 }),
  synth('version-missing', (() => {
    const { version: _v, ...rest } = validServerManifest
    return rest
  })()),
  synth('description-wrong-type-boolean', { ...validServerManifest, description: true }),

  // ── E. Category enum ──
  synth('category-invalid-string', { ...validServerManifest, category: 'weird' }),
  synth('category-case-sensitive-CLI', { ...validCliManifest, category: 'CLI' }),
  synth('category-wrong-type-number', { ...validCliManifest, category: 5 }),
  synth('category-missing', (() => {
    const { category: _c, ...rest } = validCliManifest
    return rest
  })()),

  // ── F. Category↔block coupling refine
  // ('category must have exactly its own config block (no others)') ──
  synth('server-category-without-server-block', (() => {
    const { server: _s, ...rest } = validServerManifest
    return rest
  })()),
  synth('client-category-without-client-block', (() => {
    const { client: _c, ...rest } = validClientManifest
    return rest
  })()),
  synth('cli-category-without-cli-block', (() => {
    const { cli: _c, ...rest } = validCliManifest
    return rest
  })()),
  synth('server-category-with-extra-client-block', {
    ...validServerManifest,
    client: { entry: './index.html' },
  }),
  synth('cli-category-with-all-three-blocks', {
    ...validCliManifest,
    client: { entry: './index.html' },
    server: { command: 'node' },
  }),
  // Refine gating (zod-4 abort rule): an ABORTING issue anywhere in the
  // manifest's subtree suppresses the category refine entirely...
  synth('refine-gated-by-unrecognized-key', {
    name: 'x',
    version: '1.0.0',
    label: 'L',
    description: 'D',
    category: 'cli',
    bogusUnknownKey: 1,
  }),
  synth('refine-gated-by-invalid-enum', {
    ...validServerManifest,
    category: 'weird',
    server: undefined,
  }),
  // ...but a NON-aborting check failure (too_small) does NOT gate it.
  synth('refine-not-gated-by-too-small', {
    name: '',
    version: '1.0.0',
    label: 'L',
    description: 'D',
    category: 'cli',
  }),
  // ...and the refine consumes BEST-EFFORT block presence: a block whose own
  // parse produced only check-failures (too_small on command) still counts as
  // PRESENT, so a matching category passes the refine — only the inner
  // too_small is reported.
  synth('refine-passes-when-matching-block-has-only-check-failures', {
    name: 'x',
    version: '1.0.0',
    label: 'L',
    description: 'D',
    category: 'server',
    server: { command: '' },
  }),
  // Two refine levels fire together, deeper path first.
  synth('both-refine-levels-fire-deeper-first', {
    name: 'x',
    version: '1.0.0',
    label: 'L',
    description: 'D',
    category: 'server',
    cli: { command: 'c' },
    contentSchema: { f: { type: 'number', label: 'L', default: 's' } },
  }),

  // ── G. Unknown-key strictness at every object level ──
  synth('unknown-top-level-key-typo', { ...validServerManifest, descripton: 'typo' }),
  synth('unknown-top-level-keys-plural-order', {
    ...validCliManifest,
    aa: 1,
    zz: 2,
  }),
  synth('picker-unknown-key-typo', {
    ...validClientManifest,
    picker: { shortcut: 'C', gropu: 'tools' },
  }),
  synth('server-config-unknown-key-typo', {
    ...validServerManifest,
    server: { ...validServerManifest.server, commmand: 'node' },
  }),
  synth('client-config-unknown-key', {
    ...validClientManifest,
    client: { entry: './index.html', entrypoint: './other.html' },
  }),
  synth('cli-config-unknown-key-flags', {
    ...validCliManifest,
    cli: { command: 'htop', flags: ['--color'] },
  }),
  synth('contentschema-field-unknown-key', {
    ...validClientManifest,
    contentSchema: { name: { type: 'string', label: 'Name', placeholder: 'Enter name' } },
  }),
  synth('terminalbehavior-unknown-key', {
    ...validCliManifest,
    cli: { command: 'x', terminalBehavior: { preferedRenderer: 'canvas' } },
  }),

  // ── H. Server config: command / timeouts / bounds ──
  synth('server-command-empty', {
    ...validServerManifest,
    server: { ...validServerManifest.server, command: '' },
  }),
  synth('server-command-wrong-type', {
    ...validServerManifest,
    server: { ...validServerManifest.server, command: 42 },
  }),
  synth('server-command-missing', {
    ...validServerManifest,
    server: { args: ['x'] },
  }),
  synth('server-readytimeout-negative', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: -1 },
  }),
  synth('server-readytimeout-zero', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: 0 },
  }),
  synth('server-readytimeout-non-integer', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: 1.5 },
  }),
  synth('server-readytimeout-negative-non-integer', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: -1.5 },
  }),
  // zod-4 .int() is SAFE-int: |x| <= 2^53-1. Check failures ACCUMULATE
  // (int-range too_small AND positive too_small) — they do not short-circuit.
  synth('server-readytimeout-below-safe-int', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: -9007199254740992 },
  }),
  synth('server-readytimeout-above-safe-int', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: 9007199254740992 },
  }),
  // Text beyond 2^53: JSON.parse rounds via IEEE-754 before zod sees it.
  {
    name: 'server-readytimeout-text-beyond-2e53-rounds',
    rawText:
      '{ "name": "x", "version": "1.0.0", "label": "L", "description": "D", "category": "server", "server": { "command": "node", "readyTimeout": 9007199254740993 } }',
  },
  synth('server-readytimeout-wrong-type-string', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: '10000' },
  }),
  synth('server-args-non-string-element', {
    ...validServerManifest,
    server: { ...validServerManifest.server, args: ['a', 1, 'b'] },
  }),
  synth('server-args-wrong-type', {
    ...validServerManifest,
    server: { ...validServerManifest.server, args: 'x' },
  }),
  synth('server-env-non-string-value', {
    ...validServerManifest,
    server: { ...validServerManifest.server, env: { PORT: 3000 } },
  }),
  synth('server-singleton-wrong-type', {
    ...validServerManifest,
    server: { ...validServerManifest.server, singleton: 'yes' },
  }),

  // ── I. Client config ──
  synth('client-entry-empty', { ...validClientManifest, client: { entry: '' } }),
  synth('client-entry-missing', { ...validClientManifest, client: {} }),

  // ── J. CLI config: commands / templates / capability flags / maps ──
  synth('cli-command-empty', { ...validCliManifest, cli: { command: '' } }),
  synth('cli-args-non-string-element', {
    ...validCliManifest,
    cli: { command: 'htop', args: ['a', 1] },
  }),
  synth('cli-env-non-string-value', {
    ...validCliManifest,
    cli: { command: 'htop', env: { TERM: 5 } },
  }),
  synth('cli-resumeargs-non-string-element', {
    ...validCliManifest,
    cli: { command: 'x', resumeArgs: ['--resume', 42] },
  }),
  synth('cli-supportspermissionmode-wrong-type', {
    ...validCliManifest,
    cli: { command: 'x', supportsPermissionMode: 1 },
  }),
  synth('cli-supportsmodel-wrong-type', {
    ...validCliManifest,
    cli: { command: 'x', supportsModel: 'true' },
  }),
  synth('cli-supportssandbox-wrong-type', {
    ...validCliManifest,
    cli: { command: 'x', supportsSandbox: null },
  }),
  synth('cli-permissionmodevalues-non-string-value', {
    ...validCliManifest,
    cli: { command: 'x', permissionModeValues: { plan: 42 } },
  }),
  synth('cli-permissionmodeenvvar-wrong-type', {
    ...validCliManifest,
    cli: { command: 'x', permissionModeEnvVar: 5 },
  }),
  synth('cli-block-wrong-type', { ...validCliManifest, cli: 'htop' }),
  synth('cli-terminalbehavior-preferredrenderer-invalid-single-option-enum', {
    ...validCliManifest,
    cli: { command: 'x', terminalBehavior: { preferredRenderer: 'dom' } },
  }),
  synth('cli-terminalbehavior-scrollinputpolicy-invalid-multi-option-enum', {
    ...validCliManifest,
    cli: { command: 'x', terminalBehavior: { scrollInputPolicy: 'weird' } },
  }),

  // ── K. Content schema: field types, union default, typeof refine ──
  synth('contentschema-invalid-field-type', {
    ...validClientManifest,
    contentSchema: { bad: { type: 'object', label: 'Bad' } },
  }),
  synth('contentschema-field-missing-type', {
    ...validClientManifest,
    contentSchema: { f: { label: 'L' } },
  }),
  synth('contentschema-field-missing-label', {
    ...validClientManifest,
    contentSchema: { f: { type: 'string' } },
  }),
  // label is a bare z.string() — EMPTY STRING IS VALID (contrast with the
  // min(1) fields like name/version/label at the top level).
  synth('contentschema-label-empty-string-valid', {
    ...validClientManifest,
    contentSchema: { f: { type: 'string', label: '' } },
  }),
  synth('contentschema-number-field-string-default-mismatch', {
    ...validClientManifest,
    contentSchema: { count: { type: 'number', label: 'Count', default: 'not-a-number' } },
  }),
  synth('contentschema-boolean-field-number-default-mismatch', {
    ...validClientManifest,
    contentSchema: { flag: { type: 'boolean', label: 'Flag', default: 42 } },
  }),
  synth('contentschema-string-field-boolean-default-mismatch', {
    ...validClientManifest,
    contentSchema: { name: { type: 'string', label: 'Name', default: true } },
  }),
  synth('contentschema-default-array-invalid-union', {
    ...validClientManifest,
    contentSchema: { f: { type: 'string', label: 'L', default: [1] } },
  }),
  synth('contentschema-default-null-invalid-union', {
    ...validClientManifest,
    contentSchema: { f: { type: 'string', label: 'L', default: null } },
  }),
  synth('contentschema-required-wrong-type', {
    ...validClientManifest,
    contentSchema: { f: { type: 'string', label: 'L', required: 'yes' } },
  }),
  synth('contentschema-field-wrong-type', {
    ...validClientManifest,
    contentSchema: { f: 'not-an-object' },
  }),
  synth('contentschema-wrong-type', { ...validClientManifest, contentSchema: 'x' }),

  // ── L. null ≠ absent for optional fields (zod .optional() rejects null;
  // the Rust port must NOT use derive Option<T> semantics) ──
  synth('picker-null-rejected', { ...validClientManifest, picker: null }),
  synth('icon-null-rejected', { ...validClientManifest, icon: null }),
  synth('cli-env-null-rejected', { ...validCliManifest, cli: { command: 'x', env: null } }),
  synth('server-null-rejected', { ...validCliManifest, category: 'server', server: null }),
  synth('server-readytimeout-null-rejected', {
    ...validServerManifest,
    server: { ...validServerManifest.server, readyTimeout: null },
  }),

  // ── M. Top-level non-object ──
  synth('top-level-array', []),
  synth('top-level-string', 'hi'),
  synth('top-level-null', null),
  synth('top-level-number', 42),
  synth('top-level-boolean', true),

  // ── N. Issue ordering pins ──
  // Property issues emit in SCHEMA-DEFINITION order, unrecognized last,
  // regardless of input member order.
  {
    name: 'issue-order-definition-order-not-input-order',
    rawText:
      '{ "version": "", "name": "", "category": "cli", "label": "", "description": "", "cli": { "command": "x" } }',
  },
  synth('unrecognized-keys-issue-position-after-field-issues', {
    aa: 1,
    name: '',
    version: 5,
    label: 'L',
    description: 'D',
    category: 'weird',
    zz: 2,
    cli: { command: 'x' },
  }),
] as const

// ── O. Bundled manifests (rawText = exact file bytes, so whitespace/ordering
// in the repo's extensions/ tree is part of the fixture) ──
const bundledDir = path.join(REPO_ROOT, 'extensions')
const bundled = readdirSync(bundledDir)
  .filter((d) => {
    try {
      readFileSync(path.join(bundledDir, d, 'freshell.json'), 'utf8')
      return true
    } catch {
      return false
    }
  })
  .sort()
  .map((d) => ({
    name: `bundled-${d}`,
    rawText: readFileSync(path.join(bundledDir, d, 'freshell.json'), 'utf8'),
  }))

const allCases = [...cases, ...bundled]

// ──────────────────────────────────────────────────────────────
// Emit
// ──────────────────────────────────────────────────────────────

const oracle = {
  meta: {
    generator: 'port/contract/generate-manifest-oracle.ts',
    schemaSource: 'server/extension-manifest.ts (UNMODIFIED legacy zod schema)',
    zodVersion: ZOD_VERSION,
    note: 'GENERATED — do not edit by hand. Regenerate: npx tsx port/contract/generate-manifest-oracle.ts',
  },
  cases: allCases.map((c): OracleCase => ({ name: c.name, rawText: c.rawText, expected: judge(c.rawText) })),
}

const text = JSON.stringify(oracle, null, 2) + '\n'
mkdirSync(path.dirname(ORACLE_PATH), { recursive: true })
writeFileSync(ORACLE_PATH, text)
console.log(
  `manifest oracle written: ${ORACLE_PATH} (${allCases.length} cases, zod ${ZOD_VERSION}, ` +
    `${oracle.cases.filter((c) => c.expected.success).length} valid / ` +
    `${oracle.cases.filter((c) => !c.expected.success).length} invalid)`,
)
