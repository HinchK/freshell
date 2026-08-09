# HARNESS-04 — Multi-provider session corpus builder — Evidence

**Item (verbatim):** *Add a multi-provider session corpus builder. Generate isolated Claude,
Codex, OpenCode, and Amplifier histories, including archived/deleted sessions, summaries,
provider titles, nested git repositories, worktrees, fractional timestamps, and more than one
page of results.*

**Playwright validation (checklist):** *A fixture-only contract parses the corpus
manifest/hashes and optionally opens it through legacy to prove expected semantics; it does
not require Rust multi-provider indexing. It deletes the temporary home and proves the real
home was untouched.*

**Branch:** `df1/harness-04-session-corpus` (base `4edd8d10e`) · **Plan:** `docs/plans/df1/HARNESS-04.md`
(includes the load-bearing ledger; L1/L6/L7 were validated by run-code probes pre-execution).

## What landed

New builder `test/e2e-browser/helpers/session-corpus/` (types, manifest+sha256, per-provider
writers for Claude/Codex/OpenCode/Amplifier, git-layout fixtures, overrides, orchestrator)
plus its Vitest suite and the Playwright contract spec
`test/e2e-browser/specs/harness-04-session-corpus.spec.ts` (legs A/B/C), registered in
MATRIX_SPECS (one additive line in `playwright.config.ts` — the only shared-file edit).

**Corpus (default):** 78 sessions — 67 listed (> one 50-item directory page → cursor page 1+2
proven), 7 absent (4 freshell-side `deleted` overrides + codex `archived_sessions/` rollout +
opencode `time_archived` row + opencode `parent_id` child row), 4 default-hidden with
toggle-only visibility (claude subagent at the REAL `<slug>/<parent>/subagents/agent-*.jsonl`
layout w/ sidechain lines; claude 1-message non-interactive; claude init-only untitled; codex
`source:'exec'`). Coverage of every named element:

- *archived/deleted*: freshell `sessionOverrides` in isolated `.freshell/config.json` (4
  flagged-archived at the sort tail, 4 deleted → never listed) + provider-level archives
  (codex archived_sessions dir, opencode `time_archived`)
- *summaries*: claude trailing `summary` lines (title+summary wire fields), codex
  first-assistant-text summary, amplifier `description`, freshell `summaryOverride` (opencode echo)
- *provider titles*: claude provider-generated (summary-line), opencode row `title`, amplifier
  `name`; user `titleOverride` layering (opencode echo rename wins)
- *nested git repositories*: outer/inner `.git` dirs (HEAD-validated) — inner repo resolves as
  its own root; a repo-subdir session resolves to the outer root
- *worktrees*: hand-written `.git` FILE + `gitdir:` + `commondir` pair → projectPath collapses
  to the main checkout, checkoutPath = worktree root (fixture validated against the real
  `resolveGitRepoRoot`/`resolveGitCheckoutRoot` resolvers in unit tests)
- *fractional timestamps*: ISO ms spread INSIDE one second across the 52 bulk session cohort,
  a same-second `.100/.200/.300` trio with exact wire ordering asserted, and amplifier numeric
  fractional `created` floored exactly
- *more than one page*: 67 listed vs `MAX_DIRECTORY_PAGE_ITEMS=50` → `nextCursor` traversal
  of both pages, exact union identity vs manifest

**Manifest:** `<home>/.freshell-corpus/manifest.json` (formatVersion 1) — sha256+bytes+role for
every file written (claude/codex/amplifier transcripts, opencode.db, config.json, git-fixture
internals), per-session wire expectations (key, title, summary, projectPath, checkoutPath, cwd,
createdAt, lastActivityAt, archived, visibility, reveal toggles), git fixture records, roots,
pagination block. Validated disk round-trip; `walkCoveragePaths` proves 100% coverage.

**Isolation:** every path/id/title embeds `h04corpus-<runToken>`; leg A deletes the temp home
and then asserts (a) absent-before real provider dirs stayed absent, (b) no file/dir NAME under
the real `~/.claude/.codex/.amplifier/.local/share/opencode` contains the marker (depth-capped),
(c) the real `~/.freshell/config.json` (present on this live host) contains no marker.

## Green runs (exact commands, SHA `HEAD`)

```
nice -n 19 npx vitest run --config test/e2e-browser/vitest.config.ts helpers/session-corpus/session-corpus.test.ts
# 20/20 passed (final SHA) — manifest core, writers, git layouts (real resolvers), orchestrator

nice -n 19 npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium specs/harness-04-session-corpus.spec.ts
# 6/6 passed (25.7–30.4s) — THREE consecutive green runs at this content (both projects),
# plus earlier per-project greens during development. Leg B boots the LEGACY server by design
# (validation text: "opens it through legacy"), under both matrix projects.
```

Scoped strict typecheck of the new files: clean except one TS2322 instance identical to the
merged `session-directory-matrix.spec.ts:110` precedent (e2e tree is outside every repo
tsconfig `include`; pattern identical to merged CI-green specs).

## Design decisions

- **Legacy-pinned server leg under both matrix projects.** The checklist validation scopes the
  open-through leg to legacy explicitly and excuses Rust indexing here ("does not require Rust
  multi-provider indexing"). MATRIX_SPECS registration (per df1 README convention) runs the
  spec on both projects; the rust-chromium leg exercises corpus build + manifest + tripwires
  through the identical legacy-open path. Rust-side indexing of this corpus is the later
  SESSION-* items' job.
- **Hand-written `.git` fixtures, no git binary.** Matches
  `test/unit/server/coding-cli/resolve-git-root.test.ts` shapes; validated pre-build by a tsx
  probe against the production resolvers (load-bearing L1) which all resolved as designed.
- **Archived cohort = oldest timestamps.** The wire sorts archived items last; giving them the
  oldest times makes archived-last order == natural time order, so (lastActivityAt,key) cursor
  pagination is provably stable across the archived boundary.
- **Real claude subagent layout discovered mid-build.** Initial `<slug>/subagents/` shape was
  never listed by the legacy reader (it scans `<slug>/<entry>/subagents/`); corpus follows the
  real per-session-dir layout with sidechain lines (`isSidechain`, `agentId`, `promptId`, no
  sessionId → filename-derived id `agent-<hex>`).
- **Tri-state expectation model** (`listed | absent | hidden-default` + `visibleWith`) keeps
  "missing" and "filtered" distinct; production semantics re-verified at runtime for opencode
  (real `runOpencodeListingQuery` in unit tests) and amplifier (`parseAmplifierMetadata`).
- **mtime pinning for amplifier sidecars** (utimes to seeded instants) — avoids the matrix-spec
  time-bomb class where build-time "now" dominates seeded recency.

## Review loop

Round 1 — fresh-agent reviewer unavailable on this box (fresh-agent spawn via the orchestration
MCP timed out twice, no tab created, zero tabs listed); used the dispatch-sanctioned fallback:
structured fresh-eyes self-review against `.claude/skills/.system/review-agent/SKILL.md`'s
checklist (integrity gate: read AGENTS.md; whole diff vs merge-base `4edd8d10e`; surrounding
production readers re-derived). Findings applied: (P2) empty-marker tripwire could false-positive
after a failed build — guarded; (P3) hardcoded page size instead of manifest-driven — fixed.
Non-findings recorded: rust-leg "theater" concern (intentional per validation text; documented
in spec header + here); ad-hoc-tsc TS2322 (identical to merged matrix-spec instance; e2e tree
not repo-tscscope). No remaining P0–P2 findings. Specs re-run green (6/6, both projects, 3rd
consecutive) after the fixes.
