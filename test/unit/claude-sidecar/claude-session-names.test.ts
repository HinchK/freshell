// test/unit/server/claude-session-names.test.ts
//
// Unified agent names (plan Task 3) — executes the REAL
// `crates/freshell-claude-sidecar/session-names.mjs` helper as a child process
// with the SDK call boundary INJECTED (FRESHELL_CLAUDE_SDK_SESSION_NAMES_MODULE,
// the same env-seam pattern index.mjs's query module uses), so the pinned
// behavior is the helper's contract — one JSON line in, one structured line
// out, project-key handling via the child-only environment, and the
// ambiguous-copy refusal — without any real SDK/auth/provider call.

// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HELPER = path.join(REPO_ROOT, 'crates', 'freshell-claude-sidecar', 'session-names.mjs')
const FAKE_SDK = path.join(__dirname, 'fixtures', 'fake-session-names-sdk.mjs')

const children = new Set<ChildProcess>()
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

interface HelperAnswer {
  ok: boolean
  op?: string
  customTitle?: string | null
  summary?: string | null
  firstPrompt?: string | null
  lastModified?: number | null
  class?: string
  message?: string
}

/** A real temp CLAUDE_CONFIG_DIR with a transcript planted under the
 * project key Claude Code derives from the dir — the helper's Rust parent
 * supplies this env; the test reproduces it to pin the child-only contract. */
function configRootWithTranscript(projectDir: string, sessionId: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'freshell-session-names-'))
  const projectKey = projectDir.replaceAll('/', '-').replaceAll('.', '-')
  const projectRoot = path.join(root, 'projects', projectKey)
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(
    path.join(projectRoot, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, sessionId }) + '\n',
  )
  return root
}

function runHelper(
  request: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<HelperAnswer> {
  const child = spawn(process.execPath, [HELPER], {
    env: {
      ...process.env,
      FRESHELL_CLAUDE_SDK_SESSION_NAMES_MODULE: FAKE_SDK,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout!.on('data', (chunk) => (out += chunk.toString()))
    child.stderr!.on('data', (chunk) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean)
      expect(lines, `helper stderr: ${err}`).toHaveLength(1)
      resolve(JSON.parse(lines[0]!) as HelperAnswer)
    })
    child.stdin!.write(JSON.stringify(request) + '\n')
    child.stdin!.end()
  })
}

describe('Claude session-names helper (SDK boundary injected)', () => {
  it('reads one JSON line in and answers ONE structured line out', async () => {
    const root = configRootWithTranscript('/work/project', '11111111-2222-3333-4444-555555555555')
    const answer = await runHelper(
      { op: 'read', sessionId: '11111111-2222-3333-4444-555555555555', dir: '/work/project' },
      { CLAUDE_CONFIG_DIR: root },
    )
    expect(answer.ok).toBe(true)
    expect(answer.op).toBe('read')
    expect(answer.customTitle).toBe('Fake Custom Title')
    expect(answer.summary).toBe('Fake summary')
    expect(answer.lastModified).toBe(1750000000000)
    rmSync(root, { recursive: true, force: true })
  })

  it('renames through the SDK with only the original dir — no sessionStore, no query', async () => {
    const root = configRootWithTranscript('/work/renamed', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const answer = await runHelper(
      {
        op: 'rename',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: 'New Native Title',
        dir: '/work/renamed',
      },
      { CLAUDE_CONFIG_DIR: root },
    )
    expect(answer).toEqual({ ok: true, op: 'rename' })
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses renames for sessions that are not under the selected project', async () => {
    const root = configRootWithTranscript('/work/selected', '11111111-2222-3333-4444-555555555555')
    const answer = await runHelper(
      {
        op: 'rename',
        sessionId: 'ffffffff-0000-0000-0000-000000000000',
        title: 'Whatever',
        dir: '/work/selected',
      },
      { CLAUDE_CONFIG_DIR: root },
    )
    expect(answer).toMatchObject({ ok: false, class: 'not-found' })
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses renames when the same session id resolves ambiguously (copies are not writable)', async () => {
    // The fake SDK answers a DIFFERENT file signature for the store-wide
    // probe than for the dir-bound probe — an ambiguous copy.
    const root = configRootWithTranscript('/work/ambiguous', '22222222-3333-4444-5555-666666666666')
    const answer = await runHelper(
      {
        op: 'rename',
        sessionId: '22222222-3333-4444-5555-666666666666',
        title: 'Ambiguous',
        dir: '/work/ambiguous',
      },
      { CLAUDE_CONFIG_DIR: root, FRESHELL_FAKE_SDK_AMBIGUOUS: '1' },
    )
    expect(answer).toMatchObject({ ok: false, class: 'ambiguous' })
    rmSync(root, { recursive: true, force: true })
  })

  it('addresses the SDK with ONLY dir — never the alpha sessionStore option', async () => {
    // The filesystem path uses ONLY the original project dir: the fake SDK
    // refuses any call carrying the alpha `sessionStore` option, so a clean
    // read proves the helper addressed the local filesystem via `dir` alone.
    const root = configRootWithTranscript('/work/no-override', '33333333-4444-5555-6666-777777777777')
    const answer = await runHelper(
      { op: 'read', sessionId: '33333333-4444-5555-6666-777777777777', dir: '/work/no-override' },
      { CLAUDE_CONFIG_DIR: root },
    )
    expect(answer.ok).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('classifies invalid requests without touching the SDK', async () => {
    const answer = await runHelper({ op: 'rename', sessionId: '', title: 'x', dir: '/d' })
    expect(answer).toMatchObject({ ok: false, class: 'invalid' })
    const answer2 = await runHelper({ op: 'read', sessionId: 'boom', dir: '/d' }, { CLAUDE_CONFIG_DIR: '/tmp' })
    expect(answer2).toMatchObject({ ok: false, class: 'error', message: 'sdk exploded' })
  })
})
