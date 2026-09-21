/**
 * Resolve the owning checkout's real tsx binary for test-side tsx stubs.
 *
 * Test fixtures that stub `node_modules/.bin/tsx` into a hermetic repo must
 * embed an ABSOLUTE path to a working tsx runtime. A relative path is a
 * freeze bomb: the stub lives at `node_modules/.bin/tsx` inside the fixture
 * repo, so a relative `exec "node_modules/.bin/tsx"` resolves to the stub
 * itself and /bin/sh exec-loops on one spinning process forever — exactly
 * how a gitless cloud test image (no `.git` metadata) froze a whole shard
 * worker with zero output until the task timeout killed it.
 *
 * Resolution order:
 * 1. Git common dir (unchanged behavior for git checkouts, worktrees
 *    included): `git rev-parse --path-format=absolute --git-common-dir`
 *    from `startDir`, then `node_modules/.bin/tsx` under the owning root.
 * 2. Package.json walk-up (gitless images): the nearest ancestor directory
 *    containing `package.json` is the project root; `node_modules/.bin/tsx`
 *    under it is the runtime. The cloud test image ships no `.git`, and its
 *    `/app` root has both `package.json` and `node_modules/.bin/tsx`, so
 *    this always resolves absolutely there.
 *
 * Throws a clear error naming both strategies when neither resolves, so a
 * broken environment fails fast instead of stubbing a relative path.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const GIT_PROBE_TIMEOUT_MS = 10_000

function tsxViaGitCommonDir(startDir: string): string | null {
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: startDir,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (res.error || res.status !== 0) return null
  const commonDir = (res.stdout ?? '').trim()
  if (!commonDir) return null
  const owningRoot = commonDir.replace(/\/\.git$/, '')
  const tsx = path.join(owningRoot, 'node_modules', '.bin', 'tsx')
  return fs.existsSync(tsx) ? tsx : null
}

function nearestPackageJsonRoot(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function resolveOwningTsx(startDir: string): string {
  const viaGit = tsxViaGitCommonDir(startDir)
  if (viaGit) return viaGit
  const packageRoot = nearestPackageJsonRoot(startDir)
  const viaWalk = packageRoot === null ? null : path.join(packageRoot, 'node_modules', '.bin', 'tsx')
  if (viaWalk !== null && fs.existsSync(viaWalk)) return viaWalk
  const walkDetail =
    packageRoot === null
      ? 'no ancestor directory contains package.json'
      : `${viaWalk} does not exist under project root ${packageRoot}`
  throw new Error(
    `resolveOwningTsx: no tsx runtime resolves from ${startDir}. Neither strategy produced an existing ` +
      `node_modules/.bin/tsx — (1) git common-dir resolution (git rev-parse --path-format=absolute ` +
      `--git-common-dir, then node_modules/.bin/tsx under the owning root) and (2) package.json walk-up ` +
      `(nearest ancestor package.json, then its node_modules/.bin/tsx): ${walkDetail}.`,
  )
}
