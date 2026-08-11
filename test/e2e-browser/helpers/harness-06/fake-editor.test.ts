import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createFakeEditor, type FakeEditor } from './fake-editor.js'

/**
 * HARNESS-06 fake-editor coverage (FILE-04's future "fake opener"): the
 * wrapper is a real executable on PATH-style invocation, records EXACT argv/
 * cwd/pid per invocation to a JSONL ledger, and supports deterministic
 * failure modes (exit code, delay, crash).
 */

const execFileP = promisify(execFile)
const editors: FakeEditor[] = []

async function make(): Promise<FakeEditor> {
  const e = await createFakeEditor()
  editors.push(e)
  return e
}

afterEach(async () => {
  while (editors.length) await editors.pop()!.cleanup()
})

describe('harness-06 fake-editor', () => {
  it('creates an executable POSIX wrapper + a .cmd wrapper', async () => {
    const e = await make()
    const st = await fs.stat(e.editorPath)
    expect(st.mode & 0o111).toBeGreaterThan(0) // executable
    expect((await fs.readFile(e.editorPath, 'utf8'))).toContain('fake-editor.mjs')
    expect(await fs.stat(e.cmdPath)).toBeTruthy()
  })

  it('records exact argv/cwd per invocation and exits 0 by default', async () => {
    const e = await make()
    await execFileP(e.editorPath, ['plain.txt'])
    await execFileP(e.editorPath, ['+12:5', 'file with spaces.py'])
    await execFileP(e.editorPath, ['--goto', 'ünïcodé.ts:7:3'])

    const invocations = await e.readInvocations()
    expect(invocations).toHaveLength(3)
    expect(invocations[0].argv).toEqual(['plain.txt'])
    expect(invocations[1].argv).toEqual(['+12:5', 'file with spaces.py'])
    expect(invocations[2].argv).toEqual(['--goto', 'ünïcodé.ts:7:3'])
    expect(path.isAbsolute(invocations[0].cwd)).toBe(true)
    expect(invocations[0].pid).toBeGreaterThan(0)
    expect(new Set(invocations.map((i) => i.pid)).size).toBe(3) // one process per open
  })

  it('passes FAKE_EDITOR_* knobs through from the caller environment', async () => {
    const e = await make()
    await expect(
      execFileP(e.editorPath, ['locked.txt'], { env: { ...process.env, FAKE_EDITOR_EXIT_CODE: '42' } }),
    ).rejects.toMatchObject({ code: 42 })
    const invocations = await e.readInvocations()
    expect(invocations).toHaveLength(1)
    expect(invocations[0].argv).toEqual(['locked.txt'])
  })

  it('logs before crashing on --fixture-crash (invocation is never lost)', async () => {
    const e = await make()
    const result = await execFileP(e.editorPath, ['--fixture-crash', 'boom.ts']).catch((err) => err)
    expect(result.code === null || result.code !== 0).toBe(true)
    const invocations = await e.readInvocations()
    expect(invocations).toHaveLength(1)
    expect(invocations[0].argv).toEqual(['--fixture-crash', 'boom.ts'])
  })

  it('honors FAKE_EDITOR_SLEEP_MS (stays alive until the delay elapses)', async () => {
    const e = await make()
    const started = Date.now()
    const child = execFile(e.editorPath, ['slow.txt'], {
      env: { ...process.env, FAKE_EDITOR_SLEEP_MS: '1500' },
    }, () => {})
    await new Promise((r) => setTimeout(r, 400))
    expect(child.exitCode).toBeNull() // still blocked in the editor
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
    const invocations = await e.readInvocations()
    expect(invocations.map((i) => i.argv)).toEqual([['slow.txt']])
  }, 15_000)

  it('readInvocations tolerates a missing log (no opens yet) and cleanup removes everything', async () => {
    const e = await make()
    expect(await e.readInvocations()).toEqual([])
    const dir = e.dir
    await e.cleanup()
    await expect(fs.stat(dir)).rejects.toThrow()
    editors.pop() // already cleaned
  })
})
