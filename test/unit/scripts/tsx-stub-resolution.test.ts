// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveOwningTsx } from '@test/helpers/tsx-stub-resolution'

const SPAWN_TIMEOUT_MS = 10_000

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFakeTsx(root: string): string {
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx')
  fs.mkdirSync(path.dirname(tsx), { recursive: true })
  fs.writeFileSync(tsx, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(tsx, 0o755)
  return tsx
}

function gitInit(dir: string): void {
  const res = spawnSync('git', ['init', '-q', '-b', 'main'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (res.status !== 0) throw new Error(`git init failed in fixture: ${res.stderr}`)
}

describe('resolveOwningTsx', () => {
  it('walks up from a nested dir to the nearest package.json root when git metadata is absent', () => {
    const root = makeTempDir('tsx-resolve-gitless-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const fakeTsx = writeFakeTsx(root)
      const nested = path.join(root, 'test', 'unit', 'scripts')
      fs.mkdirSync(nested, { recursive: true })
      const resolved = resolveOwningTsx(nested)
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved).toBe(fakeTsx)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers the git common-dir owning root over a nearer package.json root (git checkout behavior)', () => {
    const root = makeTempDir('tsx-resolve-git-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const owningTsx = writeFakeTsx(root)
      gitInit(root)
      const decoyRoot = path.join(root, 'packages', 'nested')
      fs.mkdirSync(decoyRoot, { recursive: true })
      fs.writeFileSync(path.join(decoyRoot, 'package.json'), '{ "private": true }\n')
      const decoyTsx = writeFakeTsx(decoyRoot)
      const start = path.join(decoyRoot, 'test', 'unit', 'scripts')
      fs.mkdirSync(start, { recursive: true })
      const resolved = resolveOwningTsx(start)
      expect(resolved).toBe(owningTsx)
      expect(resolved).not.toBe(decoyTsx)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws a clear error naming both strategies when no ancestor has package.json', () => {
    const root = makeTempDir('tsx-resolve-bare-')
    try {
      const nested = path.join(root, 'a', 'b')
      fs.mkdirSync(nested, { recursive: true })
      expect(() => resolveOwningTsx(nested)).toThrowError(/git/)
      expect(() => resolveOwningTsx(nested)).toThrowError(/package\.json/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws with the found project root when the nearest package.json lacks node_modules/.bin/tsx', () => {
    const root = makeTempDir('tsx-resolve-no-bin-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const nested = path.join(root, 'a', 'b')
      fs.mkdirSync(nested, { recursive: true })
      expect(() => resolveOwningTsx(nested)).toThrowError(/project root/)
      expect(() => resolveOwningTsx(nested)).toThrowError(/node_modules\/\.bin\/tsx/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves an absolute, existing tsx for the running test tree (owning checkout in git checkouts)', () => {
    const resolved = resolveOwningTsx(import.meta.dirname)
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved.endsWith(path.join('node_modules', '.bin', 'tsx'))).toBe(true)
    expect(fs.existsSync(resolved)).toBe(true)
    // In a git checkout (local dev and CI), pin the owning-checkout path
    // exactly — this is the behavior rust-test-targets.test.ts depends on.
    // Gitless images (the cloud test image ships no .git) skip only this
    // equality pin; the invariants above still hold via the walk-up.
    const probe = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    if (probe.status === 0 && (probe.stdout ?? '').trim()) {
      const owningRoot = (probe.stdout ?? '').trim().replace(/\/\.git$/, '')
      expect(resolved).toBe(path.join(owningRoot, 'node_modules', '.bin', 'tsx'))
    }
  })
})
