# Logger Separation Flake Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the flaky integration test `test/integration/server/logger.separation.test.ts` (test "debug log separation > concurrent launches with the same mode keep separate files") so it passes reliably under the cloud test backend.

### Explicit constraints
- Fix the flakiness (system over symptom); do not skip, weaken, or reduce coverage of the test.
- Work in a dedicated worktree on a branch from origin/main; do not merge the branch (PR happens separately).
- Cloud backends are configured for vitest and e2e (FRESHELL_VITEST_BACKEND/FRESHELL_E2E_BACKEND=cloud); broad/base gates against origin/main go through scripts/base-gate.sh.

### Accepted tradeoffs and residuals
- A prior mitigation already on main (widening the file-content wait from 5s to 30s) did not eliminate the flake; the fix must address why the expected log line never appears under shard contention, not merely the wait duration.

**Goal:** The debug-log startup receipt (`Resolved debug log path`) is written durably at logger construction, so a short-lived process that imports `server/logger.ts` and exits promptly never loses it, and the `logger.separation` integration tests pass deterministically on local and cloud backends.

**Architecture:** `createLogger()` currently routes the one-time marker through the lazily-opened `rotating-file-stream`, so the line sits in an in-memory buffer that `process.exit()` can discard. Replace that one marker write with a synchronous `fs.appendFileSync` receipt of identical JSON shape, emitted inside the same `createLogger()` path and the same try/catch. Rotating-file-stream then handles only the ongoing verbose stream, unchanged.

**Tech Stack:** Node.js/TypeScript (NodeNext/ESM), pino, rotating-file-stream, Vitest.

## Global Constraints

- Server code is NodeNext/ESM; relative imports must include `.js` extensions. The fix adds no new imports (`fs` and `path` are already imported in `server/logger.ts`).
- The marker line's JSON shape must stay byte-compatible with what the integration test parses: top-level `msg: "Resolved debug log path"`, `filePath`, `debugMode`, `debugInstance`, `app: "freshell"`, `env`, `version` (omitted when undefined), plus pino's `level: 30`, `severity: "info"`, `time` (ISO-8601). The current pino options replace `base` with `{app, env, version}`, so the marker line carries **no** `pid`/`hostname` — do not add them.
- Respect level semantics: the marker today is an `info` log, suppressed when the effective level is above `info` (e.g. `LOG_LEVEL=warn`). The synchronous write preserves that by gating on `isLevelEnabled('info')`.
- The marker goes only to the debug file, never to stdout/stderr (the console stream sits at `error` level and the first integration test asserts the marker never appears there).
- Never reduce coverage: do not skip or delete any existing test; the existing 30s content gates stay as-is.
- Run tests through repo-owned paths (`npm run test:vitest -- ...`), from the run worktree `/home/dan/code/freshell/.worktrees/logger-separation-flake`.
- `rotating-file-stream` tracks file size for rotation from its own writes; the out-of-band receipt is one short line per process launch — acceptable and noted, no guard needed.

---

### Task 1: Durable synchronous startup marker in `createLogger()`

**Files:**
- Modify: `server/logger.ts` (marker emission at ~line 344-347; new helper near `createDebugFileStream` at ~line 231)
- Test: `test/unit/server/logger.test.ts` (append a new `describe` at the end)
- Test: `test/integration/server/logger.separation.test.ts` (append one new test inside the existing `describe('debug log separation', ...)`)

**Interfaces:**
- Consumes: `createLogger()` (`server/logger.ts`), `resolveDebugLogPath()` semantics (explicit `LOG_DEBUG_PATH` short-circuits the test-runtime null — that is what makes the unit test possible under vitest), the existing `logger.separation.test.ts` harness (`startSourceLoggerProcess`, `activeProcesses`).
- Produces: no new exported interface; `createLogger()` behavior change only (marker durability).

- [ ] **Step 1: Write the failing behavioral tests**

Part A — unit test (in `test/unit/server/logger.test.ts`): first merge any missing imports (`readFileSync` and `existsSync` from `node:fs`, `fsp` from `node:fs/promises`, `os` from `node:os`, `path` from `node:path`) into the file's import block — skip any already present. Then append a new `describe` at the end of the file's existing top-level `describe`, reusing the file's existing `vi.resetModules()`-in-`beforeEach` + dynamic re-import convention:

```ts
import { existsSync, readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ...inside the file's existing top-level describe, at the end:

  describe('startup debug marker durability', () => {
    it('writes the resolved-path marker synchronously during logger construction', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-logger-marker-'))
      const debugPath = path.join(dir, 'debug.jsonl')
      delete process.env.LOG_LEVEL
      process.env.LOG_DEBUG_PATH = debugPath
      try {
        await import("../../../server/logger")
        // No waiting: the receipt must be durable before createLogger() returns.
        // Pre-fix the marker only sat buffered in the lazily-opened rotating
        // stream, so this file is missing or empty at this point.
        const content = readFileSync(debugPath, 'utf8')
        const line = content
          .split(/\r?\n/)
          .find((l) => l.includes('Resolved debug log path'))
        expect(line).toBeDefined()
        const parsed = JSON.parse(line as string)
        expect(parsed).toMatchObject({
          msg: 'Resolved debug log path',
          level: 30,
          severity: 'info',
          app: 'freshell',
          filePath: debugPath,
        })
        expect(typeof parsed.time).toBe('string')
        expect(parsed.debugMode).toBeDefined()
        expect(parsed.debugInstance).toBeDefined()
        expect(parsed).not.toHaveProperty('pid')
        expect(parsed).not.toHaveProperty('hostname')
      } finally {
        delete process.env.LOG_DEBUG_PATH
      }
    })

    it('respects info-level suppression for the marker', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-logger-marker-suppressed-'))
      const debugPath = path.join(dir, 'debug.jsonl')
      process.env.LOG_DEBUG_PATH = debugPath
      process.env.LOG_LEVEL = 'warn'
      try {
        await import("../../../server/logger")
        // The file may not exist yet: at warn level nothing is written
        // synchronously, and the lazily-opened stream may never have landed.
        // Absence IS the suppressed outcome — only guard content if present.
        const content = existsSync(debugPath) ? readFileSync(debugPath, 'utf8') : ''
        expect(content).not.toContain('Resolved debug log path')
      } finally {
        delete process.env.LOG_DEBUG_PATH
        delete process.env.LOG_LEVEL
      }
    })
  })
```

Note for the implementer: at `LOG_LEVEL=warn` pre-fix the empty-file state satisfies `not.toContain` vacuously (see Step 2). Post-fix the marker must exist in the durability test and remain absent in the suppression test — the pair pins both halves of the `isLevelEnabled('info')` gate. If the suppression test fails post-fix, that is a real production defect to fix, not a test to weaken.

Part B — integration test (append inside `describe('debug log separation', ...)` in `test/integration/server/logger.separation.test.ts`; add `import { once } from 'node:events'` to the imports at top):

```ts
  it(
    'keeps the resolved-path receipt durable when the process exits immediately after import',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        // The red lever: NO post-import timer at all — the child exits on the
        // first macrotask after the import resolves, so rotating-file-stream's
        // async open can never win. Pre-fix this is 100% red on any machine;
        // post-fix the synchronous receipt makes it 100% green.
        const IMMEDIATE_EXIT_PROBE = [
          '(async () => {',
          "  process.argv = ['node', 'server/index.ts']",
          "  await import('./server/logger.ts')",
          '  process.exit(0)',
          '})()',
        ].join('\n')
        const proc = await startServerProcess(
          [process.execPath, getTSXCLI(), '-e', IMMEDIATE_EXIT_PROBE],
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'immediate-exit',
            NODE_ENV: 'development',
            // The harness does not scrub ambient LOG_LEVEL; the marker is
            // info-level, so an operator's LOG_LEVEL=warn would suppress it
            // and keep this test red. Pin the supported default instead.
            LOG_LEVEL: 'debug',
          },
          REPO_ROOT,
        )
        activeProcesses.push(proc)
        await once(proc.process, 'exit')

        const markerPath = path.join(logDir, 'server-debug.development.immediate-exit.jsonl')
        const content = await fsp.readFile(markerPath, 'utf8').catch(() => '')
        expect(content).toContain('Resolved debug log path')

        const startupPayload = parseStartupLogPayload(content)
        expect(startupPayload).not.toBeNull()
        expect(startupPayload).toMatchObject({
          debugMode: 'development',
          debugInstance: 'immediate-exit',
        })
      })
    },
  )
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run:
```bash
npm run test:vitest -- run test/unit/server/logger.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/integration/server/logger.separation.test.ts --config config/vitest/vitest.server.config.ts
```

Command-form note (verified empirically this run): `test/unit/server/**` lives in the SERVER vitest config — the default config excludes it. The explicit `--config` keeps the coordinator's `test:vitest` passthrough verbatim; WITHOUT it the coordinator infers the server owner and prepends a second `run`, which vitest then treats as a filename filter — an unscoped `npm run test:vitest -- run test/unit/server/logger.test.ts` selected 11 files / 243 tests instead of 1 file / 36 tests.

Expected: FAIL for exactly two new tests, for the durability reason: the unit durability test finds no `Resolved debug log path` line (file missing or empty at assertion time), and the integration test fails with `expect(content).toContain('Resolved debug log path')` receiving `''`. The second new unit test (`respects info-level suppression...`) may PASS pre-fix — pre-fix nothing reaches the file promptly at any level, so `not.toContain` is satisfied vacuously; it is a guard test whose real value is post-fix (marker written when allowed, still suppressed at `warn`). All pre-existing tests in both files still pass.

If either new test unexpectedly PASSES pre-fix, stop: the repro is not load-bearing; re-investigate before implementing (do not weaken the test to manufacture a failure).

- [ ] **Step 3: Add the minimal production implementation**

In `server/logger.ts`, add the helper next to `createDebugFileStream` (~line 231):

```ts
/**
 * One-time startup receipt for the resolved debug log destination, appended
 * SYNCHRONOUSLY at logger construction. rotating-file-stream opens lazily and
 * buffers writes until its async open completes; a short-lived process that
 * imports this module and exits promptly would otherwise lose the marker
 * (observed as a hung-then-empty debug file in the logger.separation
 * integration suite under CI shard contention). The direct append makes the
 * receipt durable before createLogger() returns. One out-of-band line per
 * process launch: rotating-file-stream's open-time stat may or may not see
 * these bytes yet (threadpool race), so rotation size accounting can be off
 * by at most this one line at the 10M cap — negligible.
 */
function writeDebugLogPathMarkerSync(resolved: {
  filePath: string
  debugMode: LogMode
  debugInstance: string
}): void {
  const line = {
    level: 30,
    severity: 'info',
    time: new Date().toISOString(),
    app: 'freshell',
    env,
    version: appVersion,
    ...resolved,
    msg: 'Resolved debug log path',
  }
  fs.appendFileSync(resolved.filePath, `${JSON.stringify(line)}\n`)
}
```

Then, in `createLogger()`, replace:

```ts
  const nextLogger = pino(createPinoOptions(), pino.multistream(streams))
  if (resolvedDebugLog) {
    nextLogger.info(resolvedDebugLog, 'Resolved debug log path')
  }
  return nextLogger
```

with:

```ts
  const nextLogger = pino(createPinoOptions(), pino.multistream(streams))
  if (resolvedDebugLog && nextLogger.isLevelEnabled('info')) {
    writeDebugLogPathMarkerSync(resolvedDebugLog)
  }
  return nextLogger
```

Placement detail: the `writeDebugLogPathMarkerSync` call replaces — not duplicates — the stream-routed marker. The existing `try/catch` that builds `resolvedDebugLog` still covers stream construction and stays as-is. The level gate belongs on the constructed logger (`isLevelEnabled`), which requires `nextLogger` to exist; and the marker write gets its own narrow guard so a filesystem failure degrades to a diagnostic warning instead of crashing startup. The final shape of the section:

```ts
  const nextLogger = pino(createPinoOptions(), pino.multistream(streams))
  if (resolvedDebugLog && nextLogger.isLevelEnabled('info')) {
    try {
      writeDebugLogPathMarkerSync(resolvedDebugLog)
    } catch (err) {
      consoleDiagnosticLogger.warn({ err, filePath: resolvedDebugLog.filePath }, 'Debug log marker write failed')
    }
  }
  return nextLogger
```

This is the intended final shape: one synchronous receipt, swallowed-with-warning on failure, console streams untouched.

- [ ] **Step 4: Run the focused tests**

Run:
```bash
npm run test:vitest -- run test/unit/server/logger.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/integration/server/logger.separation.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS — both new tests and every pre-existing test in both files.

- [ ] **Step 5: Refactor while green**

- Remove now-unneeded machinery only if the marker's old pino route left anything (it did not add any).
- Keep the 30s `FILE_CONTENT_TIMEOUT_MS` — it bounds content gates, not durability; the file's header comment about the 2026-08-18 observation stays accurate but should gain one sentence noting the durability fix (edit the comment, do not change the timeout value).
- Recorded behavior deltas, accepted deliberately:
  - If the debug file is already at the 10MB rotation cap at process start, rotating-file-stream rotates at open time, which can move the freshly appended receipt into the rotated archive, leaving the active file without the marker. Diagnostic-only, never exercised by any test; no guard added.
  - The first integration test's `LOG_LEVEL_PROBE` (50ms timer) keeps the theoretical exit-before-open loss window for its `error-level` content line; the reported flake concerned the marker receipt, which is now durable. No change in scope.

- [ ] **Step 6: Run impacted-test verification**

The change affects only `createLogger()` marker emission. Impacted set: every test that imports the real `server/logger.ts` marker path (the two files above) plus any test asserting on `createDebugFileStream`/debug streams. Unit runtime is gated away from the marker by `isTestRuntime`/env deletion except via explicit `LOG_DEBUG_PATH`, which only `logger.test.ts` uses.

Run:
```bash
npm run test:vitest -- run test/unit/server/logger.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/integration/server/logger.separation.test.ts --config config/vitest/vitest.server.config.ts
rg -l "createDebugFileStream|Resolved debug log path" test/ | tr '\n' ' '
```

Run any additional files the `rg` lists that actually execute the marker path (not docs).

Expected: PASS for the full impacted set.

Then verify on the configured CLOUD backend — the venue where the flake lives (the local-focused commands above never reach it). The repo's cloud script takes `=`-joined flags:

```bash
bash scripts/vitest-cloud.sh run --cloud --config=server test/integration/server/logger.separation.test.ts
```

Expected: all tests in the file pass on Cloud Run. (Local `npm run test:vitest -- run <file> --config <path>` demonstrably selects the intended file and config — verified by observation earlier today; keep it for local loops only.)

- [ ] **Step 7: Commit the task**

```bash
git add server/logger.ts test/unit/server/logger.test.ts test/integration/server/logger.separation.test.ts
git commit -m "fix(server): write the debug-path startup receipt synchronously so short-lived imports never lose it"
```

---
