import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * HARNESS-06 fake-editor fixture builder (FILE-04's "fake opener").
 *
 * Materializes two thin wrappers into a fresh temp dir, both exec'ing the
 * committed payload `test/e2e-browser/fixtures/fake-editor.mjs`:
 *
 *   - `fake-editor`     POSIX shell wrapper (mode 0755) — the value a spec
 *                       hands the server-under-test as the editor command.
 *   - `fake-editor.cmd` Windows wrapper (for native-Windows lanes).
 *
 * The payload logs every invocation to `FAKE_EDITOR_LOG` (exported through
 * the wrappers) before honoring its behavior knobs; `readInvocations()`
 * parses that ledger for exact argv assertions.
 */

export interface EditorInvocation {
  pid: number
  t: number
  argv: string[]
  cwd: string
}

export interface FakeEditor {
  /** POSIX wrapper path — the editor command to hand the server under test. */
  editorPath: string
  /** Windows `.cmd` wrapper path (sibling, for native-Windows lanes). */
  cmdPath: string
  /** The JSONL ledger the payload appends to. */
  logPath: string
  dir: string
  readInvocations: () => Promise<EditorInvocation[]>
  cleanup: () => Promise<void>
}

const PAYLOAD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/fake-editor.mjs',
)

export async function createFakeEditor(): Promise<FakeEditor> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-h06-editor-'))
  const logPath = path.join(dir, 'invocations.jsonl')
  const editorPath = path.join(dir, 'fake-editor')
  const cmdPath = path.join(dir, 'fake-editor.cmd')

  // The wrappers must not swallow the caller's FAKE_EDITOR_* env: only
  // inject the log path, inherit everything else (knobs included).
  const sh =
    '#!/bin/sh\n' +
    `# HARNESS-06 fake editor wrapper -> ${PAYLOAD}\n` +
    `export FAKE_EDITOR_LOG="\${FAKE_EDITOR_LOG:-${logPath}}"\n` +
    `exec "${process.execPath}" "${PAYLOAD}" "$@"\n`
  const cmd = [
    '@echo off',
    `rem HARNESS-06 fake editor wrapper -> ${PAYLOAD}`,
    `if not defined FAKE_EDITOR_LOG set "FAKE_EDITOR_LOG=${logPath}"`,
    `"${process.execPath}" "${PAYLOAD}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')

  await fsp.writeFile(editorPath, sh, { mode: 0o755 })
  await fsp.writeFile(cmdPath, cmd)

  return {
    editorPath,
    cmdPath,
    logPath,
    dir,
    readInvocations: async () => {
      let text: string
      try {
        text = await fsp.readFile(logPath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EditorInvocation)
    },
    cleanup: async () => {
      await fsp.rm(dir, { recursive: true, force: true })
    },
  }
}
