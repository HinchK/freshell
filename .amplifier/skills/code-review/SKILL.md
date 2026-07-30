---
name: code-review
description: "Review changed code for reuse, quality, and efficiency, then fix any issues found."
context: fork
disable-model-invocation: true
user-invocable: true
argument-hint: "<repo-path> [expected-branch] [focus notes]"
model_role: critique
---

# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found — but only after Phase 0 verifies you are targeting the right repository.

## Phase 0: Verify the Target (do this before reading any code)

You may be running as a forked sub-session: you inherit NO conversation
history, and your working directory is NOT guaranteed to be the repository
you were meant to review.

1. Parse `$ARGUMENTS` for a target repo path and (optionally) an expected
   branch. If a path is given: cd there, and prefix every git command with
   `git -C <path>`.
2. Echo your target before proceeding — print the output of:
   `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git status --porcelain=v1 | head -20`.
3. REFUSE to continue (report the mismatch as your final message; make no
   edits, launch no review agents) when ANY of these hold:
   - An expected branch was given and does not match the current branch.
   - No explicit target path was given AND the checkout is on main/master
     AND `git status` shows uncommitted changes. You cannot attribute those
     changes (you have no conversation history); they belong to someone
     else. Reviewing-and-fixing them is corruption, not cleanup.
   - No explicit target path was given and there is nothing this session
     itself changed. (As a fork, "files you edited earlier in this
     conversation" is always empty — do not substitute "whatever is dirty
     in cwd" for it.)
4. When refusing, state: the toplevel and branch you found, the dirty files
   you declined to touch, and what invocation would make the review valid
   (e.g. "re-invoke with the worktree path as $ARGUMENTS").

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes and `$ARGUMENTS` names specific files, review those; otherwise report "nothing to review" and stop.

## Phase 2: Launch Three Review Agents in Parallel

Use the delegate tool to launch all three agents concurrently in a single message. Pass each agent the full diff so it has the complete context.

### Agent 1: Code Reuse Review

For each change:
1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Review

Review the same changes for hacky patterns:
1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary nesting**: wrapper elements that add no layout or structural value — check if inner component props already provide the needed behavior

### Agent 3: Efficiency Review

Review the same changes for efficiency:
1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

If `$ARGUMENTS` is provided, all three agents should also pay special attention to: `$ARGUMENTS`

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate their findings.

Fix issues directly ONLY when Phase 0 established a verified target: an
explicit path was provided (or the tree's only changes are attributable to
this session) AND any expected branch matched. Otherwise run in
REPORT-ONLY mode: write the aggregated findings to
`<repo>/.discovery/code-review-findings-<timestamp>.md` (or return them
inline), and make ZERO edits. Never write into a dirty tree whose changes
you cannot attribute.

If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

When done, briefly summarize what was fixed (or confirm the code was already clean).
