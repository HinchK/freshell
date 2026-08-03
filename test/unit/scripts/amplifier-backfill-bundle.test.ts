// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  resolveActiveBundle,
  detectIndent,
  applyBlockedByLiveAmplifier,
  sessionLooksLive,
  backfillSession,
} from '../../../scripts/amplifier-backfill-bundle.js'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-backfill-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, contents)
}

function dirs() {
  return { globalDir: path.join(root, 'home-amplifier'), workDir: path.join(root, 'work') }
}

describe('resolveActiveBundle (mirror of Rust bundle_config semantics)', () => {
  it('resolves from global settings only', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('foundation')
  })

  it('later layers win: project then local override global', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.yaml'), 'bundle:\n  active: proj\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('proj')
    await write(
      path.join(workDir, '.amplifier', 'settings.local.yaml'),
      'bundle:\n  active: local\n',
    )
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('local')
  })

  it('returns null when no files exist', async () => {
    const { globalDir, workDir } = dirs()
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('garbage YAML in any existing layer poisons the whole resolution', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.local.yaml'), 'bundle: [unclosed')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('non-string or empty bundle.active poisons the whole resolution', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: true\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: ""\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('a layer without the key does not clear an earlier winner', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.yaml'), 'ui:\n  theme: dark\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('foundation')
  })

  it('multi-document settings poison the whole resolution (mirrors Rust)', async () => {
    const { globalDir, workDir } = dirs()
    await write(
      path.join(globalDir, 'settings.yaml'),
      'bundle:\n  active: foundation\n---\nbundle:\n  active: other\n',
    )
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('duplicate active keys resolve last-wins (mirrors Rust/saphyr)', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: one\n  active: two\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('two')
  })

  it('falls back to global-only when workingDir is undefined', async () => {
    const { globalDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(await resolveActiveBundle(globalDir, undefined)).toBe('foundation')
  })
})

describe('detectIndent', () => {
  it('detects two-space, four-space, tab, and compact', () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2)
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4)
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t')
    expect(detectIndent('{"a":1}')).toBe(0)
  })
})

describe('applyBlockedByLiveAmplifier', () => {
  it('blocks on any amplifier process, ignoring its own process tree', () => {
    expect(applyBlockedByLiveAmplifier('python3 /home/u/.local/bin/amplifier\n')).toBe(true)
    expect(applyBlockedByLiveAmplifier('bash\nnvim notes.md\n')).toBe(false)
    // Self-exclusion: the gate must not trip on the backfill's own
    // node/npx/tsx process tree (its argv contains the script filename).
    expect(
      applyBlockedByLiveAmplifier(
        'node /repo/node_modules/.bin/tsx scripts/amplifier-backfill-bundle.ts --apply\n' +
          'npm exec tsx scripts/amplifier-backfill-bundle.ts --apply\n',
      ),
    ).toBe(false)
    // ...but a real amplifier process alongside it still blocks.
    expect(
      applyBlockedByLiveAmplifier(
        'node /repo/node_modules/.bin/tsx scripts/amplifier-backfill-bundle.ts --apply\n' +
          'python3 /home/u/.local/bin/amplifier\n',
      ),
    ).toBe(true)
  })
})

describe('sessionLooksLive', () => {
  it('flags a matching amplifier process', async () => {
    const sessionDir = path.join(root, 's1')
    await fs.mkdir(sessionDir, { recursive: true })
    const ps = '/usr/bin/python3 amplifier resume 123e4567-e89b-4000-8000-000000000001\n'
    expect(
      await sessionLooksLive('123e4567-e89b-4000-8000-000000000001', sessionDir, ps, Date.now()),
    ).toBe(true)
  })

  it('flags a recently-written events.jsonl and clears an old one', async () => {
    const sessionDir = path.join(root, 's2')
    await write(path.join(sessionDir, 'events.jsonl'), '')
    const now = Date.now()
    expect(await sessionLooksLive('deadbeef', sessionDir, '', now)).toBe(true) // just written
    expect(await sessionLooksLive('deadbeef', sessionDir, '', now + 11 * 60_000)).toBe(false)
  })
})

describe('backfillSession', () => {
  function sessionFixture(meta: Record<string, unknown>, indent = 2) {
    const sessionDir = path.join(
      root,
      'projects',
      '-w',
      'sessions',
      '123e4567-e89b-4000-8000-00000000000a',
    )
    const metaPath = path.join(sessionDir, 'metadata.json')
    return { sessionDir, metaPath, raw: JSON.stringify(meta, null, indent) + '\n' }
  }

  it('updates an eligible session, preserving other keys, order, indent', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: '123e4567-e89b-4000-8000-00000000000a',
      created: '2026-01-01T00:00:00.000Z',
      working_dir: workDir,
      freshell_terminal_id: 'term-x',
    })
    await write(metaPath, raw)

    const outcome = await backfillSession(metaPath, {
      globalDir,
      apply: true,
      psOutput: '',
      nowMs: Date.now() + 11 * 60_000,
    })
    expect(outcome).toBe('updated')
    const after = await fs.readFile(metaPath, 'utf8')
    const parsed = JSON.parse(after)
    expect(parsed.bundle).toBe('foundation')
    expect(parsed.freshell_terminal_id).toBe('term-x')
    expect(Object.keys(parsed)).toEqual([
      'session_id',
      'created',
      'working_dir',
      'freshell_terminal_id',
      'bundle',
    ])
    expect(after).toMatch(/\n {2}"session_id"/) // 2-space indent preserved
    expect(after.endsWith('\n')).toBe(true)
  })

  it('replaces bundle "unknown" in place', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      bundle: 'unknown',
      working_dir: workDir,
      freshell_terminal_id: 'term-x',
    })
    await write(metaPath, raw)
    const outcome = await backfillSession(metaPath, {
      globalDir,
      apply: true,
      psOutput: '',
      nowMs: Date.now() + 11 * 60_000,
    })
    expect(outcome).toBe('updated')
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    expect(parsed.bundle).toBe('foundation')
    expect(Object.keys(parsed)).toEqual([
      'session_id',
      'bundle',
      'working_dir',
      'freshell_terminal_id',
    ]) // position preserved
  })

  it('is ineligible without freshell_terminal_id or with a real bundle', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const a = sessionFixture({ session_id: 'x', working_dir: workDir })
    await write(a.metaPath, a.raw)
    expect(
      await backfillSession(a.metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now(),
      }),
    ).toBe('ineligible')

    const b = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
      bundle: 'foundation',
    })
    await write(b.metaPath, b.raw)
    expect(
      await backfillSession(b.metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now(),
      }),
    ).toBe('ineligible')
  })

  it('skips live sessions and leaves the file untouched', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
    })
    await write(metaPath, raw)
    const ps = 'amplifier resume 123e4567-e89b-4000-8000-00000000000a\n'
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: true,
        psOutput: ps,
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('skipped-live')
    expect(await fs.readFile(metaPath, 'utf8')).toBe(raw)
  })

  it('skips when nothing resolves; dry-run never writes', async () => {
    const { globalDir, workDir } = dirs()
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
    })
    await write(metaPath, raw)
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('skipped-unresolved')

    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: false,
        psOutput: '',
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('would-update')
    expect(await fs.readFile(metaPath, 'utf8')).toBe(raw) // untouched
  })

  it('skips files whose bytes cannot be reproduced faithfully', async () => {
    // ledger A16: JSON.stringify re-emits 5.0 as 5 — never touch such files.
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath } = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 'term-x',
    })
    const raw =
      '{\n  "session_id": "x",\n  "working_dir": ' +
      JSON.stringify(workDir) +
      ',\n  "freshell_terminal_id": "term-x",\n  "default_launch_wait": 5.0\n}\n'
    await write(metaPath, raw)
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('skipped-unfaithful')
    expect(await fs.readFile(metaPath, 'utf8')).toBe(raw) // untouched
  })
})
