// Package-manager selection for the shared pre-push hook (plan 7.4).
//
// The hook is installed via an absolute core.hooksPath pointing at the main
// checkout's scripts/hooks, so it runs against npm-era and pnpm-era branches
// alike. Selection must therefore come from the PUSHING worktree (the hook's
// CWD), never from the hook-owner checkout or the caller's npm_execpath.
// packageManager is authoritative; a legacy npm lock without pnpm metadata
// selects npm; a pnpm lock without the field selects pnpm.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type HookPackageManager = 'pnpm' | 'npm'

export interface PackageManagerSelection {
  manager: HookPackageManager
  source: 'packageManager-field' | 'lock-fallback'
}

export interface TypecheckInvocation {
  command: string
  args: string[]
}

const PINNED_PNPM = 'pnpm@10.34.5'

function declaredPackageManager(rootDir: string): string | null {
  try {
    const raw = readFileSync(join(rootDir, 'package.json'), 'utf8')
    const field = (JSON.parse(raw) as { packageManager?: unknown })?.packageManager
    if (typeof field !== 'string' || field.length === 0) return null
    return field.split('@')[0]
  } catch {
    return null
  }
}

export function selectPackageManager(rootDir: string): PackageManagerSelection {
  const declared = declaredPackageManager(rootDir)
  if (declared === 'pnpm' || declared === 'npm') {
    return { manager: declared, source: 'packageManager-field' }
  }
  const hasPnpmLock = existsSync(join(rootDir, 'pnpm-lock.yaml'))
  const hasNpmLock = existsSync(join(rootDir, 'package-lock.json'))
  if (hasPnpmLock && !hasNpmLock) {
    return { manager: 'pnpm', source: 'lock-fallback' }
  }
  return { manager: 'npm', source: 'lock-fallback' }
}

export function buildTypecheckInvocation(manager: HookPackageManager): TypecheckInvocation {
  if (manager === 'pnpm') {
    // pnpm forwards post-script args directly — never emit an npm-style
    // '--' separator.
    return { command: 'pnpm', args: ['run', '--silent', 'typecheck'] }
  }
  return { command: 'npm', args: ['run', '--silent', 'typecheck'] }
}

export function missingManagerRemediation(manager: HookPackageManager): string {
  if (manager === 'pnpm') {
    return `npm install --global ${PINNED_PNPM}`
  }
  return 'install Node.js/npm (the nvm loader is attempted automatically)'
}

// Stable key=value stdout lines consumed by scripts/hooks/pre-push. Values
// never contain '=' or newlines, so the hook's IFS='=' read loop can parse
// them losslessly.
export function formatTypecheckSelection(rootDir: string): string {
  const { manager, source } = selectPackageManager(rootDir)
  const invocation = buildTypecheckInvocation(manager)
  return [
    `manager=${manager}`,
    `source=${source}`,
    `command=${invocation.command}`,
    `args=${invocation.args.join(' ')}`,
    `remediation=${missingManagerRemediation(manager)}`,
  ].join('\n')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const rootDir = process.argv[2]
  if (!rootDir) {
    console.error('usage: prepush-manager.ts <pushing-worktree-root>')
    process.exit(2)
  }
  console.log(formatTypecheckSelection(rootDir))
}
