// Pins + extends the coverage guard of scripts/deploy-tab-diff.sh.
//
// WHY THIS EXISTS (2026-07-29 incident): the coverage guard -- "which running
// terminals are covered by NO persisted snapshot pane" -- used to live ONLY in
// `verify`, i.e. AFTER the restart, when the uncovered PTYs are already dead.
// 9 of 28 running terminals were killed that way. This suite (a) pins verify's
// guard byte-exactly so the shared-function refactor cannot drift it, and
// (b) drives the new capture-time gate (exit 4, --allow-uncovered).
//
// Harness idiom (fake `curl` on PATH, exit 99 == network call happened) is
// borrowed from test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts -- the
// established way to test this script hermetically. Everything here is
// self-contained: no server, no real network, mkdtemp + finally cleanup.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
// Resolve from this file, not cwd: vitest workers do not guarantee repo-root cwd.
const SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../scripts/deploy-tab-diff.sh',
)

async function runScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(SCRIPT, args, {
      env: { ...process.env, ...env },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// --- capture-shaped fixture builders (shape mirrors the script's artifact:
// {capturedAt, url, devices:{id:{deviceId,records}}, terminals:[], bundles}) ---
const term = (
  terminalId: string,
  status: 'running' | 'exited',
  extra: Record<string, unknown> = {},
) => ({ terminalId, status, ...extra })

const pane = (paneId: string, liveTerminalId: string | null, mode = 'shell') => ({
  paneId,
  kind: 'terminal',
  payload: {
    mode,
    sessionRef: null,
    liveTerminal: liveTerminalId ? { terminalId: liveTerminalId } : null,
  },
})

const openRecord = (tabKey: string, panes: unknown[]) => ({
  status: 'open',
  tabKey,
  tabName: `Tab ${tabKey}`,
  panes,
})

const captureDoc = (terminals: unknown[], records: unknown[]) => ({
  capturedAt: 1000,
  url: 'http://unused.invalid',
  devices: { 'dev-1': { deviceId: 'dev-1', records } },
  terminals,
  bundles: { 'dev-1': { components: ['g-1'], capturedAt: 10 } },
})

// Fake curl that aborts (exit 99) on ANY invocation: proves the code path
// under test performs zero network I/O.
async function makeAbortCurl(tmp: string) {
  const binDir = path.join(tmp, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(
    path.join(binDir, 'curl'),
    '#!/usr/bin/env bash\necho "NETWORK CALL (curl) during offline verify" >&2\nexit 99\n',
    { mode: 0o755 },
  )
  return binDir
}

describe('deploy-tab-diff verify coverage guard (pinned: decision + output must not change)', () => {
  it('FAILs (exit 1) listing every uncovered running terminal as bare "  - id" lines', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      // term-covered: running + covered by a pane. term-orphan: running,
      // covered by NOTHING. term-done: exited -> must NOT be flagged.
      const doc = captureDoc(
        [
          term('term-covered', 'running'),
          term('term-orphan', 'running'),
          term('term-done', 'exited'),
        ],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(1)
      expect(r.code).not.toBe(99) // offline mode made zero network calls
      expect(r.out).not.toContain('NETWORK CALL')
      // Byte-exact header (script line "FAIL: ${n} running terminal(s)..."):
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // verify's list is bare ids by contract -- NOT the enriched capture format.
      expect(r.out).toMatch(/^ {2}- term-orphan$/m)
      expect(r.out).not.toMatch(/^ {2}- term-covered$/m)
      expect(r.out).not.toContain('term-done')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('passes the guard and reports OK (exit 0) when every running terminal is covered', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      const doc = captureDoc(
        [term('term-covered', 'running')],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      // --after = same file: identity diff is trivially clean, so this exits 0
      // only if the coverage guard passed.
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('OK: every previously-live pane came back with the same session identity.')
      expect(r.out).not.toContain('FAIL')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
