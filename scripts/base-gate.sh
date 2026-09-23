#!/usr/bin/env bash
# Run a broad gate (default: npm test; or any script, e.g.
# `scripts/base-gate.sh check`) from a clean scratch worktree at origin/main.
#
# Why: the cloud vitest/e2e runners treat ANY dirty state in the checkout they
# run from — including untracked files — as non-addressable, forcing a
# "<sha>-dirty" image that ALWAYS rebuilds from a cold build (~13 min) and is
# never reusable. The main checkout accumulates untracked litter (plan docs,
# agent artifacts), so base gates run there pay that rebuild every time. A
# fresh worktree at origin/main is clean by construction, so the run uses the
# content-addressed commit tag: built at most once per commit and shared by
# every later run on any machine.
#
# The coordinator gate is repo-global (keyed off the common git dir), so gate
# queuing, holder publication, and result recording behave identically from
# the scratch worktree.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
git -C "$root" fetch --quiet origin main
wt="$root/.worktrees/.base-gate-$$"
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
git -C "$root" worktree add --quiet --detach "$wt" origin/main
cd "$wt"
# Manager selection happens HERE, after entering the scratch worktree: its
# base is origin/main, which is npm-era or pnpm-era depending on when this
# runs. packageManager is authoritative; a legacy npm lock without the field
# selects npm (plan 7.4). Never decide from the launching checkout.
mgr="npm"
pm_line="$(grep -m1 '"packageManager"' package.json 2>/dev/null || true)"
case "$pm_line" in
  *pnpm*) mgr="pnpm" ;;
  *npm*) mgr="npm" ;;
  *)
    if [ -f pnpm-lock.yaml ] && [ ! -f package-lock.json ]; then
      mgr="pnpm"
    fi
    ;;
esac
script="${1:-test}"
if [ "$#" -gt 0 ]; then
  shift
fi
if [ "$mgr" = "pnpm" ]; then
  pnpm install --frozen-lockfile
  # npm-era callers pass a literal standalone '--' after the script name as
  # the launcher separator (npm's forwarding convention). pnpm forwards
  # post-script args directly, so strip exactly that one leading separator;
  # any LATER '--' the caller passed deliberately is forwarded untouched.
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  pnpm run "$script" "$@"
else
  npm ci --no-audit --no-fund
  npm run "$script" "$@"
fi
