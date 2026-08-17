# Docs Pages Own-Workflow Deployment Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Move the GitHub Pages deployment of the freshell docs site (source: `main` branch, `/docs` path, serving freshell.net, currently GitHub's auto-generated legacy `pages-build-deployment` pipeline) into a repo-owned GitHub Actions workflow in danshapiro/freshell, replicating the existing experience (build = static copy of docs/ with CNAME + .nojekyll, deploy to Pages on pushes affecting docs/, plus manual re-run capability).

### Explicit constraints
- Scope limited to only what is necessary to replicate the existing experience in our own workflow; reject any expansion beyond that (explicit user override of any skill or subskill scope pull).
- Work in the dedicated worktree on branch the-usual/docs-deploy-workflow; everything ships via a PR targeting main, and no PR is created without explicit user approval.

### Accepted tradeoffs and residuals
- Switching the repo's Pages configuration from legacy branch deployment to workflow deployment (a GitHub repo settings change, outside the PR) is inherent to owning the pipeline.

**Goal:** freshell.net keeps serving exactly the `docs/` tree, but the build+deploy runs from a workflow file in this repo instead of GitHub's hidden legacy pipeline, so failures are visible, re-runnable, and owned by us.

**Architecture:** One new workflow, `.github/workflows/docs-pages-deploy.yml`, that mirrors the observed legacy pipeline exactly: checkout (fetch-depth 1) → `actions/upload-pages-artifact` on `./docs` (artifact `github-pages`, retention 1 day) → `actions/deploy-pages`. No build step (legacy has none; `.nojekyll` present; no `_config.yml`). Single job against the pre-existing `github-pages` environment (branch policy already allows `main`). Triggers: pushes to `main` touching `docs/**` or the workflow file itself, plus `workflow_dispatch` (replaces legacy's only manual option, "Re-run jobs"). Adoption (outside the PR): flip the repo's Pages `build_type` from `legacy` to `workflow` immediately before merging, then verify by triggering the workflow and checking freshell.net.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v5` — the exact major versions the legacy pipeline itself runs), GitHub Pages, actionlint for static validation.

## Global Constraints

- Single new file only: `.github/workflows/docs-pages-deploy.yml`. No other repo file changes except this plan file (`docs/plans/2026-08-17-docs-deploy-workflow.md`). No `docs/index.html` change (not a user-facing product feature), no `AGENTS.md` change (no agent workflow change), no code changes.
- Scope: replicate only. No retry wrappers beyond what GitHub/Actions natively provide, no monitoring/alerting additions, no staging environment, no PR-time preview deployments, no Jekyll build, no `actions/configure-pages` (legacy does not run one and the site is pure static).
- Repo workflow style (from existing `.github/workflows/*.yml`): kebab-case `.yml` filename; `name:` in Title Case; explicit minimal `permissions:` block; `concurrency:` block present; `timeout-minutes` on the job; `ubuntu-latest` runner; actions referenced by major-version tag (never SHA-pinned).
- Required permissions for Pages Actions deploy: `contents: read`, `pages: write`, `id-token: write` (the OIDC token is mandatory for `deploy-pages`; legacy had it implicitly).
- Environment name is exactly `github-pages` (hyphen), which already exists with a branch policy allowing `main` (and a stale, harmless `gh-pages` entry). Do not create a `github_pages` underscore variant.
- Commits use the existing repo git identity; never set git config. Push of the branch is allowed; `gh pr create` (or equivalent) only after explicit user approval.
- Concurrency choice: `group: pages`, `cancel-in-progress: false`. Legacy cancels superseded runs, but a cancelled `deploy-pages` job can strand a half-reported deployment; queued (not cancelled) runs reach the identical end state because site content is a pure function of `docs/`. This matches GitHub's official Pages starter workflow.

---

### Task 1: Add the repo-owned Pages deploy workflow

**Files:**
- Create: `.github/workflows/docs-pages-deploy.yml`

**Interfaces:**
- Consumes: the existing `github-pages` environment (branch policy: `main` allowed); repo Pages config (cname `freshell.net`, https enforced); `docs/CNAME` + `docs/.nojekyll` (carried through the artifact).
- Produces: workflow `Docs Pages Deploy` (id `docs-pages-deploy.yml`) that creates Pages deployments the same way the legacy pipeline does; manual trigger via `gh workflow run docs-pages-deploy.yml`.

- [x] **Step 1: Write the failing verification**

Obtain actionlint (`gh release download` without a tag fetches the latest release; Stage 2 validation confirms the toolchain works on this machine) and run it against the not-yet-existing workflow:

```bash
mkdir -p /tmp/actionlint-dl
gh release download -R rhysd/actionlint -p 'actionlint_*_linux_amd64.tar.gz' -D /tmp/actionlint-dl --clobber
tar -xzf /tmp/actionlint-dl/actionlint_*_linux_amd64.tar.gz -C /tmp/actionlint-dl
/tmp/actionlint-dl/actionlint /home/dan/code/freshell/.worktrees/docs-deploy-workflow/.github/workflows/docs-pages-deploy.yml
```

Expected: FAIL because `docs-pages-deploy.yml` does not exist yet (actionlint reports the file as unreadable). This proves the check is live before implementation.

- [x] **Step 2: Add the workflow implementation**

Create `.github/workflows/docs-pages-deploy.yml` with exactly this content (this exact YAML already passed actionlint 1.7.12 with zero diagnostics in Stage 2's green probe):

```yaml
name: Docs Pages Deploy

on:
  push:
    branches:
      - main
    paths:
      - docs/**
      - .github/workflows/docs-pages-deploy.yml
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    # 15-minute job budget: deploy step reserves 10 min (600000 ms, the Pages-side
    # cap); checkout + upload observed ~20s, leaving a ~5-minute margin.
    timeout-minutes: 15
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./docs
          name: github-pages
          retention-days: 1

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
        with:
          artifact_name: github-pages
          timeout: 600000
```

Every input mirrors the observed legacy invocation (checkout fetch-depth 1; artifact name `github-pages`, path `./docs`, retention 1 day; deploy timeout 600000 ms — Stage 2 confirmed `timeout`'s default is 600000 ms and equals the fixed Pages-side deploy cap, so the explicit value is pure documentation). The job-level `timeout-minutes: 15` gives the deploy step's 10-minute budget a ~5-minute margin (checkout + upload observed ~20s in legacy runs) — a margin, not a guarantee, since the job clock covers all steps. Major tags `@v4`/`@v3`/`@v5` match both legacy's observed actions and repo no-SHA-pinning style; Stage 2 confirmed `actions/deploy-pages@v5.0.0`'s `action.yml` defines `artifact_name` and `timeout` in milliseconds, and that the 21 MiB `docs/` tree has ~48x headroom under Pages limits.

- [x] **Step 3: Run the focused verification**

Run: `/tmp/actionlint-dl/actionlint /home/dan/code/freshell/.worktrees/docs-deploy-workflow/.github/workflows/docs-pages-deploy.yml`

Expected: PASS (no output, exit 0). actionlint 1.7.12 validates workflow syntax, event/trigger semantics, the `permissions` values, the `environment.url` expression, and inputs for actions in its embedded popular-action database (which covers `actions/checkout` and `actions/deploy-pages@v5`). It does NOT cover `actions/upload-pages-artifact`, so its three inputs (`path`, `name`, `retention-days`) rest on separate evidence: they are byte-identical to the inputs observed in the live legacy pipeline's own `upload-pages-artifact@v3` invocation (run 32056407228 logs, Stage 1 exploration report) and match the action.yml input names at `v3` (checked in both Stage 2 and plan review rounds).

- [x] **Step 4: Refactor while green**

No refactor: the file is a single 40-line declarative workflow; each line is load-bearing (permissions, concurrency, environment, artifact/deploy inputs) or style-mandated (name, timeout-minutes).

- [x] **Step 5: Run impacted-set verification**

The change is one additive CI YAML file; no application code, tests, or package configuration change. Impact analysis: vitest/jest suites do not read `.github/workflows/`; eslint configs lint JS/TS only; the port-contract and clippy workflows are unaffected by a new sibling file. Run the cheapest repo-owned confirmation that the tree is still coherent — the diff-scope guard and YAML sanity already covered by actionlint:

Run: `git -C /home/dan/code/freshell/.worktrees/docs-deploy-workflow status --short`

Expected: `.github/workflows/docs-pages-deploy.yml` as the only new untracked file, and no tracked modifications (`??` entries besides it). This plan file is already committed in earlier commits, so it does not appear in `git status`; the PR delta is judged by `git diff origin/main --stat` showing only this plan file plus the workflow.

The full coordinated suite gate is run ONCE by the run orchestrator (not the task implementer) at the end of execution, on the final HEAD: command `FRESHELL_VITEST_BACKEND=local npm run check` (typecheck + client/server Vitest suites + Electron suite; `config/vitest/vitest.config.ts` excludes `test/e2e-browser/**`, so no e2e specs are part of this gate). Pass criterion: green, excluding only failures that reproduce at base_ref and are recorded by name in the run's baseline ledger (`/home/dan/code/freshell/.worktrees/.the-usual-logs/docs-deploy-workflow/run-state.md`, see also `reports/workspace-baseline.md` in the same logs directory). Any other failure is triaged as run-introduced and fixed before the gate passes. Backend note: the cloud Vitest backend is unusable as of 2026-08-17 — every execution of the shared `freshell-vitest` Cloud Run job on that date ran the Playwright e2e entrypoint despite `TEST_MODE=vitest` being confirmed present in the execution's container env (observed on executions freshell-vitest-2r4s2, -7rdvn, -7czbm, -l6rbp; the image was built 2026-08-16 and its baked entrypoint demonstrably does not honor `TEST_MODE`, so cloud executions run the wrong suite; exact provenance of that drift was not determined). The local backend is the repo-supported equivalent and was used for both the baseline and the gate in this run.

- [x] **Step 6: Commit the task**

```bash
git -C /home/dan/code/freshell/.worktrees/docs-deploy-workflow add .github/workflows/docs-pages-deploy.yml
git -C /home/dan/code/freshell/.worktrees/docs-deploy-workflow commit -m "ci: add repo-owned GitHub Pages deploy workflow for docs site"
```

---

## Merge and adoption runbook (outside the PR; executed after the user approves PR creation)

1. Push `the-usual/docs-deploy-workflow`, open PR targeting `main` (explicit user approval first).
2. Immediately before merging, flip the repo's Pages source so the merge's own deploy run uses the new pipeline and legacy stops racing it. The PUT documents no "omitted fields are preserved" guarantee (Stage 2 finding), so the call re-asserts the current values idempotently:
   `gh api -X PUT repos/danshapiro/freshell/pages -f build_type=workflow -f cname=freshell.net -F https_enforced=true`
3. Merge the PR. The merge commit touches `docs/plans/` (this plan) and the workflow file → self-triggers `Docs Pages Deploy` (verified in Stage 2: newly added workflow files are live for the push that adds them). Fallback if the self-trigger does not appear: `gh workflow run docs-pages-deploy.yml`.
4. Watch until the site reports deployed: `gh run list --workflow docs-pages-deploy.yml --limit 1` for a success, and `gh api repos/danshapiro/freshell/pages --jq '{build_type, status, cname}'` showing `build_type: workflow`, `status: built`, `cname: freshell.net`. Poll `curl -sI https://freshell.net/` (expect 200) across the flip→deploy window; a brief outage in that window is a known accepted residual (no official doc settles it; the window is seconds-to-minutes and fully reversible).
5. Rollback if anything is wrong. Ordered so the repo-owned workflow cannot race the recovered legacy pipeline, cancellation is awaited to terminal state (GitHub returns only `202 Accepted` from `gh run cancel`), and recovery is verified against the exact requested build (Fresh Eyes rounds 1–3 findings):
   a. Disable the repo-owned workflow (prevents pushes from queueing new runs mid-rollback), then cancel every nonterminal run to a VERIFIED fixpoint — cancelling the active run can promote a queued one, so snapshot+cancel loops until a fresh snapshot shows zero nonterminal runs. The LIST call uses the raw REST endpoint `GET /actions/workflows/{file}/runs` instead of `gh run list --workflow` so behavior cannot depend on the installed gh version's workflow-resolution rules (verified against gh v2.45.0 source: NAME selectors resolve against active workflows only, `.yml` file selectors happen to bypass that filter, and `--status` rejects values such as `pending` — the raw endpoint avoids all three). The loop is fail-closed (a listing failure aborts the rollback before any flip) and paginates the entire run history:
      `gh workflow disable docs-pages-deploy.yml -R danshapiro/freshell`
      ```bash
      CANDS=$(mktemp)   # "<run-id> <head-sha>" pairs of every run ever seen nonterminal
      while true; do
        LIST=$(mktemp)
        if ! gh api --paginate "repos/danshapiro/freshell/actions/workflows/docs-pages-deploy.yml/runs?per_page=100" \
             --jq '.workflow_runs[] | select(.status | test("^(queued|in_progress|requested|waiting|pending)$")) | "\(.id) \(.head_sha)"' > "$LIST"; then
          echo "ERROR: run listing failed — aborting rollback; do NOT flip Pages settings" >&2
          exit 1
        fi
        if [ ! -s "$LIST" ]; then rm -f "$LIST"; break; fi
        cat "$LIST" >> "$CANDS"
        while read -r id sha; do
          gh run cancel -R danshapiro/freshell "$id" || echo "WARN: cancel of $id failed; the loop will re-verify" >&2
        done < "$LIST"
        rm -f "$LIST"
        sleep 5
      done
      echo "run fixpoint reached: zero nonterminal runs"

      # Pages-side sweep (always runs, even if cancellation looked clean): any run that was
      # nonterminal at any point may have created a Pages deployment — including runs GitHub
      # force-terminated (which skips the action's own cancellation handler). The deployment
      # endpoints accept the commit SHA as the identifier, and the run listing already recorded
      # every candidate SHA, so no log scraping or deployment-id format guessing is needed.
      sort -u -k2,2 "$CANDS" | while read -r id sha; do
        st=$(gh api "repos/danshapiro/freshell/pages/deployments/$sha" --jq .status 2>/dev/null) || continue  # 404: no deployment for this sha
        case "$st" in
          deployment_in_progress|syncing_files|finished_file_sync|updating_pages|purging_cdn)
            gh api -X POST "repos/danshapiro/freshell/pages/deployments/$sha/cancel"
            while :; do
              st=$(gh api "repos/danshapiro/freshell/pages/deployments/$sha" --jq .status 2>/dev/null || true)
              case "$st" in deployment_in_progress|syncing_files|finished_file_sync|updating_pages|purging_cdn) sleep 5 ;; *) break ;; esac
            done
            ;;
        esac
      done
      rm -f "$CANDS"
      echo "Pages-side sweep complete: no nonterminal Actions deployments remain"
      ```
      The sweep is the authority, not the Actions-side cancellation: a cancelled deploy-pages run only *attempts* to cancel its Pages deployment (its handler swallows API errors), and a force-terminated run skips the handler entirely. Cancelled-late deployments that already succeeded are harmless — the legacy rebuild in step c deploys byte-identical docs content over them; nonterminal ones are cancelled here. Deployment status vocabulary (verified against the REST docs): nonterminal = `deployment_in_progress`, `syncing_files`, `finished_file_sync`, `updating_pages`, `purging_cdn`; terminal = `succeed`, `deployment_cancelled`, `deployment_failed`, `deployment_content_failed`, `deployment_attempt_error`, `deployment_lost`.
   b. Flip the source back, re-asserting source/cname/HTTPS explicitly (the PUT documents no "omitted fields are preserved" guarantee):
      `gh api -X PUT repos/danshapiro/freshell/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/docs' -f cname=freshell.net -F https_enforced=true`
   c. Request a legacy build and correlate recovery to the current source tip with movement detection (a bare `/pages/builds/latest` read can describe a stale or superseded build):
      1. `gh api -X POST repos/danshapiro/freshell/pages/builds` (queues a build of the current source-branch tip)
      2. loop until success: read `TIP=$(gh api repos/danshapiro/freshell/branches/main --jq .commit.sha)` and `BUILD=$(gh api repos/danshapiro/freshell/pages/builds/latest --jq '{commit,status}')`. Success requires `BUILD.commit == $TIP` and `BUILD.status == 'built'`. If `BUILD.status == 'errored'`, abort and report — do not declare rollback complete. If `main` advanced past the built commit (i.e. `BUILD.commit != $TIP` while a new push landed), `POST /pages/builds` again and continue polling.
   d. Confirm the site serves: `curl -sI https://freshell.net/` returns 200.
   e. Stability re-check 5 minutes later: `gh api repos/danshapiro/freshell/pages/builds/latest --jq '{commit,status}'` still shows the verified legacy build for the current tip and `curl -sI https://freshell.net/` still returns 200. This guards the deploy-record ownership (both pipelines ship byte-identical `docs/` content, so even a hypothetical late-completing Actions deployment could not change served bytes — but ownership must rest with the legacy pipeline after rollback).

## Parity notes (what "replicate the existing experience" means, exactly)

- Same site content: raw `./docs` tar with `CNAME` and `.nojekyll`, no Jekyll, no build step.
- Same deploy cadence for everything that can change the site: pushes to `main` touching `docs/**`. Non-docs pushes no longer trigger deploy runs; deployed output is unchanged because content is a pure function of `docs/`.
- Same custom domain/HTTPS: unchanged in repo settings and `docs/CNAME`.
- Same deployment protection: the pre-existing `github-pages` environment (branch policy: `main`).
- Strictly additive vs. legacy within replication scope: `workflow_dispatch` manual trigger (legacy only had the Re-run button); failures now surface as ordinary repo Actions runs, which are re-runnable.
