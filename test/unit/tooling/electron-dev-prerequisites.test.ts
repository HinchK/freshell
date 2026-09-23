// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildElectronDevPrerequisitePhases,
  resolveElectronDevPrerequisitePaths,
  runElectronDevPrerequisites,
} from '../../../scripts/electron-dev-prerequisites.js'

interface SpawnOptions {
  cwd: string
  shell: boolean
  stdio: 'inherit'
  windowsHide: boolean
}

interface ManagerProject {
  root: string
  shimDir: string
}

function makeProject(manifest: Record<string, unknown> | null): ManagerProject {
  const base = mkdtempSync(path.join(tmpdir(), 'freshell-electron-prerequisites-'))
  // Spaces in the fixture root prove manager argv and entrypoint paths survive
  // spawning without shell re-parsing.
  const root = `${base} dir with spaces`
  mkdirSync(root)
  if (manifest !== null) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
  }
  const shimDir = path.join(root, 'shim-bin')
  mkdirSync(shimDir)
  writeFileSync(path.join(shimDir, 'pnpm.cmd'), '@echo off\r\n')
  return { root, shimDir }
}

function spawnWritingOutputs(
  resources: ReturnType<typeof resolveElectronDevPrerequisitePaths>,
  assertPhase: (command: string, args: string[], options: SpawnOptions) => void,
) {
  return vi.fn((command: string, args: string[], options: SpawnOptions) => {
    assertPhase(command, args, options)

    switch (args.slice(-1)[0]) {
      case 'build:client':
        mkdirSync(path.dirname(resources.clientIndex), { recursive: true })
        writeFileSync(resources.clientIndex, '<!doctype html>')
        break
      case 'build:tools':
        mkdirSync(path.dirname(resources.mcpEntry), { recursive: true })
        writeFileSync(resources.mcpEntry, 'export {}')
        break
      case 'build:rust':
        mkdirSync(path.dirname(resources.serverBinary), { recursive: true })
        writeFileSync(resources.serverBinary, 'rust release binary')
        break
    }

    return { status: 0, signal: null }
  })
}

describe('Electron development prerequisite process spawning', () => {
  it('launches a pnpm-pinned project through the shim-adjacent pnpm entrypoint on Windows', () => {
    const { root, shimDir } = makeProject({ packageManager: 'pnpm@10.34.5' })
    const entrypoint = path.join(shimDir, 'pnpm.cjs')
    writeFileSync(entrypoint, '')
    const resources = resolveElectronDevPrerequisitePaths(root, 'win32')
    const spawn = spawnWritingOutputs(resources, (command, args, options) => {
      expect(command).toBe(process.execPath)
      expect(options).toMatchObject({ cwd: root, shell: false, stdio: 'inherit', windowsHide: true })
      expect(args.slice(0, 2)).toEqual([entrypoint, 'run'])
    })

    try {
      const resolved = runElectronDevPrerequisites({
        projectRoot: root,
        platform: 'win32',
        env: { PATH: shimDir },
        spawn,
      })

      expect(resolved).toEqual(resources)
      expect(spawn).toHaveBeenCalledTimes(4)
      expect(spawn.mock.calls.map(([, args]) => [args[0], args[2]])).toEqual([
        [entrypoint, 'prebuild'],
        [entrypoint, 'build:client'],
        [entrypoint, 'build:tools'],
        [entrypoint, 'build:rust'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('spawns an unresolvable Windows pnpm shim through a shell', () => {
    const { root, shimDir } = makeProject({ packageManager: 'pnpm@10.34.5' })
    const resources = resolveElectronDevPrerequisitePaths(root, 'win32')
    const spawn = spawnWritingOutputs(resources, (command, args, options) => {
      expect(command).toBe(path.join(shimDir, 'pnpm.cmd'))
      expect(options).toMatchObject({ cwd: root, shell: true, stdio: 'inherit', windowsHide: true })
      expect(args).toEqual(['run', expect.stringMatching(/^(prebuild|build:(client|tools|rust))$/)])
    })

    try {
      runElectronDevPrerequisites({
        projectRoot: root,
        platform: 'win32',
        env: { PATH: shimDir },
        spawn,
      })

      expect(spawn).toHaveBeenCalledTimes(4)
      expect(spawn.mock.calls.every(([, , options]) => options.shell === true)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses npm without a shell on POSIX platforms for a project without the pnpm pin', () => {
    const { root } = makeProject({ name: 'legacy-project' })
    const resources = resolveElectronDevPrerequisitePaths(root, 'linux')
    const spawn = spawnWritingOutputs(resources, (command, args, options) => {
      expect(command).toBe('npm')
      expect(options).toMatchObject({ cwd: root, shell: false, stdio: 'inherit', windowsHide: true })
      expect(args.slice(0, 1)).toEqual(['run'])
    })

    try {
      runElectronDevPrerequisites({
        projectRoot: root,
        platform: 'linux',
        env: { PATH: '/bin' },
        spawn,
      })

      expect(spawn).toHaveBeenCalledTimes(4)
      expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
        ['run', 'prebuild'],
        ['run', 'build:client'],
        ['run', 'build:tools'],
        ['run', 'build:rust'],
      ])
      expect(spawn.mock.calls.every(([, , options]) => options.shell === false)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an injected spawn failure without continuing to later phases', () => {
    const { root } = makeProject({ name: 'legacy-project' })
    const spawn = vi.fn(() => ({
      error: new Error('npm is unavailable'),
      status: null,
      signal: null,
    }))

    try {
      expect(() => runElectronDevPrerequisites({
        projectRoot: root,
        platform: 'win32',
        env: { PATH: '/bin' },
        spawn,
      })).toThrow(
        'npm.cmd run prebuild failed to start: npm is unavailable',
      )
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds every phase through an explicit manager-command override', () => {
    expect(buildElectronDevPrerequisitePhases('npm')).toEqual([
      { command: 'npm', args: ['run', 'prebuild'] },
      { command: 'npm', args: ['run', 'build:client'] },
      { command: 'npm', args: ['run', 'build:tools'] },
      { command: 'npm', args: ['run', 'build:rust'] },
    ])
  })
})
