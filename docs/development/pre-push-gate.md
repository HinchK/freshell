# Local pre-push gate

Every `git push` runs the cheap local checks before anything reaches GitHub. This is the enforcement that catches unformatted or clippy-red code at push time — the class of red that landed via PR #764 while no CI checks were running.

## What runs

Filtered by what the push changes (diff between the remote refs being updated and the pushed commits):

| Push contains | Checks |
|---|---|
| Any `.rs`, `Cargo.toml`/`Cargo.lock`, `rust-toolchain*` | `cargo fmt --all --check`, then `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` |
| Any `.ts`/`.tsx`, `package.json`/`package-lock.json`, `tsconfig*` | `npm run typecheck` (client + server, tsc `--noEmit`) |
| Only docs/config/other files | Nothing |
| New branch with no merge-base with origin/main | Both gates (full) |

Cost when warm: fmt ~5s, typecheck ~1-2 min, clippy ~2-5 min on a warm target dir (first run in a fresh checkout is a cold build — longer).

## What it does NOT cover

Unit/integration vitest, e2e, electron, the real-transport clippy lanes. Those stay with the normal QA gate / PR discipline. This gate is the cheap floor, not a replacement.

## Controls

- Bypass (emergencies only): `git push --no-verify`
- Disable for one push: `FRESHELL_PREPUSH=0 git push ...`
- See routing without running checks: `FRESHELL_PREPUSH_DEBUG=1 git push --dry-run ...`
- If a lane's tooling is unavailable it is skipped with an accurate warning (not a failure). The hook self-heals stripped-environment contexts (ssh/agents/IDEs/cron): it sources `~/.nvm/nvm.sh` when `npm` is missing from PATH, and adds `~/.cargo/bin` when `cargo` is missing.

## Setup

Automatic: `npm install` runs `postinstall` → `scripts/install-hooks.mjs` → sets `core.hooksPath` to the main checkout's `scripts/hooks` (absolute). One manual step on clones that already have `node_modules`: run `node scripts/install-hooks.mjs`.

Because `core.hooksPath` points at the main checkout's copy, all linked worktrees (including ones at older commits) get the same current gate; the checks themselves execute in the pushing worktree's tree. Machines without this clone's setup (fresh machines) enforce nothing until `npm install` runs there — the gate is per-machine, it complements (not replaces) GitHub-side rules.
