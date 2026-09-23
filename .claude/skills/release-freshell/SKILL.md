---
name: release-freshell
description: Use when preparing a Freshell release — before bumping versions, writing release notes, tagging, etc on GitHub.
---

# Releasing Freshell

## When to Use

Invoke this skill before changing version numbers or cutting a release. Never release without explicit user request.

## Sanity Check

Before anything: if something seems off (discontinuous version jump like 0.25→2.6, failing tests, broken code), stop and confirm with the user.

## Writing Release Notes

Release notes are **user-facing, not code-facing**. Write from the perspective of someone using Freshell, not someone reading the git log.

### Structure

Two sections, in this order:

**"New things you can do"** — Features that let users do something they couldn't before. Each item: what it is + why you'd care. Priority-ordered (most impactful first).

**"Things that got better"** — Improvements to existing functionality. Same format: what changed + why it matters. Priority-ordered.

### Principles

- **Feature, benefit.** Not "add sessions.patch WebSocket protocol" but "Faster session sidebar — updates arrive as small patches instead of re-sends."
- **User verbs, not code verbs.** Not "centralize terminal input send path through onData" but "Paste is more reliable — all paste methods go through one pipeline."
- **Skip internal-only changes.** Test refactors, doc updates, reverts-then-re-lands — users don't care.
- **Priority order within each section.** The things that are most exciting, the things that change daily usage most, then the rest.
- **Deep-dive the changelog in preparation.** Read every commit since the last tag. Skim the files affected so you can tell if there may be changes beyond the commit note, and if so, read the diffs and source code. Group by user-visible impact. Many commits collapse into one release note line. Some commits (chore, test, docs) produce no release note at all.
- **Read the code, not just the commit messages.** Commit messages are often terse or misleading. When a commit touches UI components, user-facing config, or behavior, read the actual diff or source to understand what changed from the user's perspective. A commit titled "refactor: move X to Y" might actually introduce a visible new capability.

### Deriving Release Notes

```bash
# 1. Get the full commit list
git log v<PREV>..HEAD --oneline --no-merges

# 2. Get the diffstat for scope
git diff v<PREV>..HEAD --stat | tail -5

# 3. For commits that touch user-facing code, read the diffs
git show <hash> --stat   # what files changed?
git show <hash>          # read the diff if unclear from commit message

# 4. Walk through commits and ask: "What can the user now DO differently?"
```

### Example

```markdown
## What's New

### New things you can do

- **Launch a coding agent directly** — Pick Claude Code or Codex from the pane picker,
  choose a directory with fuzzy search, and launch. No manual cd + typing commands.
- **Know when an agent is done** — Turn-complete bell and tab attention indicators
  notify you when a coding CLI finishes its turn.

### Things that got better

- **Faster session sidebar** — Updates arrive as incremental patches instead of
  full re-sends. Noticeably snappier with many sessions.
- **Paste is reliable** — All paste paths go through one pipeline. No more
  double-pastes or dropped pastes.
```

## Version Number

Freshell uses semver. Decide the bump with the user, but offer a recommendation:

- **Patch** (0.x.Y): Incremental improvements
- **Minor** (0.X.0): Dramatic, significant, and meaningful change
- **Major** (X.0.0): Massive, exciting release, worthy of entirely new consideration

## Update the README

**This is the last step before mechanical release, and requires user approval.**

Review `README.md`'s Features section against the current state of the product. Read the relevant source code to verify claims — don't trust the README or your memory alone.

For each feature listed:

- Is it still accurate? Read the implementing code if unsure. Update or remove if the feature changed or was removed.
- Is there a new capability from this release that's more interesting or important than what's listed? Propose adding it.
- Are any listed features low-priority enough to drop? Recommend removal to keep the list tight.

Present the proposed README changes to the user for approval before proceeding to release steps.

## Release Steps

All release preparation happens on a release branch in a worktree from `origin/main`. Local `main` is a mirror of `origin/main`; do not commit to it, fast-forward it, or push it directly.

### 1. Create the release branch

```bash
# From the repo root
git fetch origin
git worktree add .worktrees/release-vX.Y.Z -b release/vX.Y.Z origin/main
cd .worktrees/release-vX.Y.Z
pnpm install --frozen-lockfile
```

pnpm 10.34.5 is the repo's pinned package manager. If the machine does not
have it yet, install it once with `npm install --global pnpm@10.34.5` (npm is
only the bootstrap). Never run `npm ci`/`npm install` in a pnpm-era tree.

### 2. Verify from a clean install

```bash
# In the worktree — start from a clean slate to catch dependency issues
rm -rf node_modules
pnpm install --frozen-lockfile

# Type-check AND build (catches errors vitest misses because it transpiles with esbuild)
pnpm run build

# Run the full test suite
pnpm run test
```

All three commands must succeed. The frozen install must complete exactly as
written — no `--force`, no `--fix-lockfile`, no un-freezing the lockfile.
`pnpm run build` catches TypeScript errors that `pnpm run test` alone does not
(vitest uses esbuild for transpilation, skipping type checking). If any step
fails, fix the issue on the release branch before proceeding.

If the release includes the desktop app, `pnpm run electron:build` (or
`electron:build:win` on native Windows) must also pass. The desktop runtime is
staged from pnpm-deploy trees, and the build ends with artifact verification
against the staging receipt (`electron-runtime/.electron-runtime-receipt.json`),
which records the pnpm version and the workspace-lock fingerprint the runtime
was built from — the receipt verification is the release's proof that the
packaged runtime matches the locked workspace.

For dependency and lock maintenance on the release branch: intentional
dependency changes use `pnpm add` / `pnpm update`, and the release PR reviews
`package.json` and `pnpm-lock.yaml` diffs together. A pure version bump does
not modify `pnpm-lock.yaml` — the lock records the workspace's external
dependency specifiers, not the root package's own version — so do not
regenerate or hand-edit the lock for the bump.

### 3. Prepare the release (on the release branch)

All of these are committed to the release branch:

1. **Bump version** in `package.json`
2. **Update README:** apply the approved Features changes, and follow the
   Quick Start's two-recipe structure: the stable-release recipe and the
   pnpm development-`main` recipe. Until the first pnpm-built release is
   published, leave the stable-release recipe pinned to the npm-era
   `v0.7.5` tag and its npm commands — that tag was built with npm.
3. **Commit** with message like `release: vX.Y.Z`

**First pnpm release:** the first release cut from pnpm `main` is the
transition point. In that release, update the README's stable-release recipe
to the new tag and to the pnpm commands (bootstrap pnpm, frozen install) in
the same release commit, so the stable-release and development recipes
converge. Do not re-point the stable recipe at a pnpm tag while keeping npm
commands, and do not ship a pnpm-tag recipe before the tag exists.

### 4. Open and merge a release PR

Push the release branch and open a PR against `main`. After user approval and required checks, merge it through GitHub. If conflicts appear, rebase the release branch onto `origin/main`, resolve in the worktree, retest, and force-push with `--force-with-lease`.

### 5. Tag and publish

```bash
git fetch origin
git tag -a vX.Y.Z -m "vX.Y.Z"
git push --tags
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."  # with the release notes
```

### 6. Clean up

```bash
git worktree remove .worktrees/release-vX.Y.Z
git branch -d release/vX.Y.Z
```

## Safety

- Local `main` mirrors `origin/main`; release work happens on a PR branch.
- Users clone a specific release tag.
- The self-hosted integration branch is `dev`, not local `main`.
- Commit the version bump before tagging so the tag points to the right commit
- If any step fails, stop and assess, then make recommendations to the user, rather than pushing forward
