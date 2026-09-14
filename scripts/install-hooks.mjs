// One-time per clone: point git's hooks at the committed scripts/hooks dir.
// Runs from npm postinstall. Silently no-ops outside a git repo (docker
// build contexts, electron rsync targets, containers without git).
//
// Uses the MAIN checkout's scripts/hooks (absolute path), so every linked
// worktree — including ones checked out at older commits — runs the same,
// current gate; the checks themselves run in the pushing worktree's tree.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

function git(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

try {
  git(['rev-parse', '--git-dir'])
} catch {
  process.exit(0)
}

try {
  const commonDir = path.resolve(git(['rev-parse', '--git-common-dir']))
  const mainRoot = path.dirname(commonDir)
  git(['config', 'core.hooksPath', path.join(mainRoot, 'scripts', 'hooks')])
  console.log(`[install-hooks] core.hooksPath -> ${path.join(mainRoot, 'scripts', 'hooks')} (pre-push gate active)`)
} catch (err) {
  console.warn(`[install-hooks] could not set core.hooksPath: ${err.message}`)
}
