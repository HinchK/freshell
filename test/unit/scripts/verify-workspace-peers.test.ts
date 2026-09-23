import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-workspace-peers.mjs')

function runScript(lockPath?: string) {
  const args = lockPath ? [SCRIPT, lockPath] : [SCRIPT]
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 })
}

describe('verify-workspace-peers', () => {
  it('enforces the real workspace lock contract on the default path', () => {
    const res = runScript()
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    expect(res.stdout).toContain('WORKSPACE PEERS OK')
  })

  it('rejects a lock whose root zod drifts from the pinned base version', () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')
    const tampered = real.replace(
      /(\n {6}zod:\n {8}specifier: 4\.3\.6\n {8}version: )4\.3\.6/,
      '$19.9.9',
    )
    expect(tampered).not.toBe(real)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-peers-'))
    const lockPath = path.join(dir, 'pnpm-lock.yaml')
    fs.writeFileSync(lockPath, tampered)
    const res = runScript(lockPath)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("dependency zod expected base version 4.3.6, observed 9.9.9")
  })

  it('fails closed when given a lock without the required top-level sections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-peers-'))
    const lockPath = path.join(dir, 'pnpm-lock.yaml')
    fs.writeFileSync(lockPath, 'lockfileVersion: 9.0\n')
    const res = runScript(lockPath)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('must have top-level')
  })
})
