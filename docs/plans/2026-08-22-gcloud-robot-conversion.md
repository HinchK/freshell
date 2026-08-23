# gcloud-robot Conversion Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Convert the freshell repository's gcloud-based tooling (the Cloud Run Jobs
test lanes and their shared image build/publish machinery) off interactive
`gcloud auth login` onto the gcloud-robot per-project robot-service-account
pattern, per the installed gcloud-robot skill.

### Explicit constraints
- Follow the gcloud-robot skill contract: survey first; least-privilege
  per-project role set derived from the surveyed surface; the converting agent
  writes but never runs GCP-mutating provisioning; no JSON keys in CI; never
  vendor the skill's scripts into the repo; runtime discovery only via
  `GCLOUD_ROBOT_HOME`; a zero-surface survey would produce zero adoption
  artifacts.
- Follow freshell repo rules (AGENTS.md): work in the dedicated worktree under
  `.worktrees/` from a green-verified base; never commit behavior changes to
  local or origin main outside the PR flow; do not create a PR without explicit
  user approval; never restart the production server.

### Accepted tradeoffs and residuals
- "Wired but not yet provisioned" is the accepted end state of this run: a
  human operator runs the documented provisioning checklist once per project
  afterward.
- A JSON key is bearer power with no MFA and no default expiry; the runbook
  must say so honestly and recommend rotation cadence, instant revocation
  steps, and key-usage alerting.

**Goal:** Freshell's cloud test lanes (e2e, vitest, image build/push) select their gcloud identity through the gcloud-robot ladder — explicit pin, `GCLOUD_IDENT`, installed-skill probe via `GCLOUD_ROBOT_HOME`, then quiet ambient fallback — so culled interactive logins stop killing agent test runs, with human sign-ins continuing to work untouched.

**Architecture:** One sourced helper (`scripts/lib/gcp-identity.sh`) carries the skill's `resolve_gcp_identity` drop-in block verbatim plus a thin bridge into the wrappers' pinned `--account` variable. Both cloud wrappers source it and resolve identity lazily, immediately before each cloud lane's first real gcloud call, so `help` and local lanes need zero GCP tooling. Hermeticity is preserved by explicit `GCLOUD_IDENT` pins in the four stubbed-gcloud suites and proven by a new identity-ladder suite that runs the real wrappers against stubbed gcloud. An operator runbook documents the one-time human provisioning and key operations; the repo never vendors the skill and no agent runs GCP-mutating commands.

**Tech Stack:** Bash (wrappers + standalone test suites under `scripts/test/`), gcloud CLI, Google Cloud Build / Cloud Run Jobs / Artifact Registry, the operator-installed `gcloud-robot` skill (discovered at runtime via `GCLOUD_ROBOT_HOME`, never committed or referenced by path).

## Global Constraints

Exact project-wide constraints every task must honor:

- **No GCP mutations by agents.** Provisioning, key, and IAM commands appear
  only as documented operator checklists (runbook, future PR body). No agent
  runs `bootstrap-robot.sh` or any IAM-mutating gcloud call.
- **Never vendor the skill.** The repo gains the drop-in block (the single
  permitted copy, kept byte-identical) but never the skill's scripts, and no
  committed file references the skill's installed location or any
  machine-local absolute path. Machine-local facts are recorded generically
  (e.g. `key-path: not yet minted — operator step`).
- **Discovery only via `GCLOUD_ROBOT_HOME`.** No other resolution mechanism.
- **No JSON keys in CI.** `.github/workflows/` has zero GCP surface today and
  stays that way; CI belongs to Workload Identity Federation (runbook note).
- **The identity ladder is fixed** (in order): call-site/repo pin wins >
  `GCLOUD_IDENT` bypass (no network) > skill probe via
  `$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh` > ambient fallback
  with ONE quiet stderr note (default) or fail-closed-with-guidance when
  `GCLOUD_ROBOT_REQUIRE=1`. The drop-in block is copied verbatim from the
  skill; never hand-compose a variant. No apostrophes inside `${...:?...}`
  messages (bash parses the interior as its own quoting context).
- **Hardcoded human default removed.** `dan@danshapiro.com` stops being any
  wrapper default. Identity precedence after conversion:
  `--account=` flag > `FRESHELL_GCP_ACCOUNT` env > `GCLOUD_IDENT` (ladder
  result) > unset (flag omitted; ambient gcloud applies, announced by the
  ladder's one-line note; `GCLOUD_ROBOT_REQUIRE=1` fails with guidance
  instead).
- **Lazy resolution only.** `freshell_resolve_cloud_identity` is called
  immediately before a cloud lane's first real gcloud call, never at script
  top. `help` and `run --local` must work on machines with NO gcloud, NO
  skill, and NO network, and must not emit any gcloud-robot output.
- **Probe permissions** (lane representatives): run/logs lanes →
  `run.jobs.run`; build/push lane → `cloudbuild.builds.create`. (Stage-2
  load-bearing items A1/A2 below.)
- **Hermetic suites stay hermetic (skill trap 11).** The four stubbed-gcloud
  suites pin `GCLOUD_IDENT=suite-pinned-identity@example.invalid` at the top
  so the rung-2 bypass fires and a stray `GCLOUD_ROBOT_HOME` can never push a
  suite onto the real probe/network path.
- **Shell safety.** Wrappers run under `set -euo pipefail`; all new expansions
  use guarded forms (`${VAR:-...}`), and command substitutions that may print
  nothing (e.g. `$(account_flag)`) must leave exit status 0.
- **Repo rules (AGENTS.md)** apply throughout: work only in this worktree on
  branch `the-usual/gcloud-robot-conversion`; conventional, focused, one
  commit per task; no PR creation; no production-server restarts; no broad
  kill patterns.
- **Role set (documented, human-applied)** for project
  `misc-puttering-project`, robot `gcloud-robot`: project-level
  `roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer`,
  `roles/run.developer`, `roles/logging.viewer`; bucket-scoped
  `roles/storage.objectAdmin` + `roles/storage.legacyBucketReader` on the
  Cloud Build staging bucket (default `misc-puttering-project_cloudbuild`,
  operator confirms); `roles/iam.serviceAccountUser` (actAs) on the project's
  default compute service account
  (`<projectNumber>-compute@developer.gserviceaccount.com`), plus — ONLY IF
  the project's Cloud Build default service account (`gcloud builds
  get-default-service-account`) is an identity the project controls — actAs
  on that identity too (the LEGACY Cloud Build SA
  `<projectNumber>@cloudbuild.gserviceaccount.com` is Google-owned and
  accepts no bindings, and
  `service-<projectNumber>@gcp-sa-cloudbuild.iam.gserviceaccount.com` is the
  service AGENT, never a build-execution identity — grant nothing on either).
  NO `roles/serviceusage.serviceUsageConsumer` (not justified by the surface).
  Role-set reasoning, verified against the official role permission lists
  (review round-1 remediation): `roles/run.developer` subsumes
  `run.invoker`/`run.jobsExecutor`/`run.viewer` for job lanes and is the
  tightest built-in that also carries `run.jobs.runWithOverrides` — REQUIRED
  because the vitest wrapper's `run jobs execute --tasks/--task-timeout/
  --update-env-vars` supplies per-execution overrides. `run.jobsExecutor`,
  `run.jobsExecutorWithOverrides`, `run.invoker`, and `run.viewer` are
  deliberately NOT in the list (each is either too narrow or redundant under
  developer). The wrapper's create-if-missing Artifact Registry path
  (`artifacts repositories create`) is NOT granted
  (`artifactregistry.repositories.create` would need repoAdmin): the operator
  checklist ensures the repository exists instead.
- **Files explicitly out of scope (untouched, with reason):**
  `scripts/run-standard-tests.ts` (it `execFileSync`s `vitest-cloud.sh` with
  inherited env; identity resolution lives inside the wrapper so the
  coordinator and base-gate paths inherit it for free);
  `docker/cloud-run/{Dockerfile,entrypoint.sh,cloudbuild.yaml}` (no gcloud
  identity inside the container; jobs/builds run as default identities — the
  actAs grant is documented in the runbook); `.gcloudignore` (no relation to
  identity); `.github/workflows/*` (zero GCP surface; CI stays keyless);
  `.env.example` (server-runtime configuration only — the cloud wrappers are
  operator shell tooling, so their knobs are documented in `--help`,
  AGENTS.md, and the runbook instead); historical `docs/plans/*` (historical
  records).

## Stage-2 load-bearing assumptions (validate before execution)

- **A1** `run.jobs.run` is a real, project-testable IAM permission for Cloud
  Run Jobs (usable in a `testIamPermissions` probe). Validate against the
  official Cloud Run IAM permission reference.
- **A2** `cloudbuild.builds.create` is a real, project-testable IAM permission
  for Cloud Build. Validate against the official Cloud Build IAM reference.
- **A3** `$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh` reads
  `GCLOUD_ROBOT_PROJECT` + `GCLOUD_ROBOT_PROBE_PERMISSION` from env and prints
  a passing account on stdout or exits 1 with empty stdout (the contract the
  new suite's fake selector models). Validate by reading the operator-installed
  script's header/usage (machine-local; allowed read).
- **A4** `bootstrap-robot.sh` consumes `GCLOUD_ROBOT_PROJECT`,
  `GCLOUD_ROBOT_ROLES`, `GCLOUD_ROBOT_ADMIN_ACCOUNT`, `--name`, `--activate`
  (runbook command correctness). Validate by reading the operator-installed
  script's usage.
- **A5** RESOLVED (stage 2, validator reports
  `reports/load-bearing-validator-a5.md`): the compute default SA form
  `<projectNumber>-compute@developer.gserviceaccount.com` is CONFIRMED; the
  claimed Cloud Build form `service-<projectNumber>@gcp-sa-cloudbuild.iam.gserviceaccount.com`
  is FALSIFIED — that address is the Google-managed Cloud Build service
  AGENT (builds never run as it; no IAM bindings possible). The real Cloud
  Build default is either the legacy `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`
  (Google-owned, accepts no bindings) or, on newer setups, the compute default
  SA; the runbook discovers it via `gcloud builds get-default-service-account`
  rather than assuming. Plan content updated accordingly.
- **A6** (raised by plan-review round 1; RESOLVED against the official Cloud
  Run IAM role permission lists): the vitest lane's per-execution overrides
  (`run jobs execute --tasks/--task-timeout/--update-env-vars`) require
  `run.jobs.runWithOverrides`; `roles/run.developer` carries it and subsumes
  `run.invoker`/`run.jobsExecutor`/`run.jobsExecutorWithOverrides`/
  `run.viewer` for these lanes, so the role set is developer + logging.viewer
  only (plus the build/AR roles). Also verified: `artifactregistry.writer`
  cannot create repositories (`repositories.create` absent) — the operator
  checklist ensures the AR repo exists instead of granting repoAdmin.

These are properties of external contracts; the plan's tasks do not depend on
any other unproven claim. If A1/A2 invalidate a probe permission, swap the
permission constant(s) — the task structure is unaffected.

---

## Workspace prep (once, before Task 1 step 2)

The worktree has no dependencies installed. Run:

```bash
cd /home/dan/code/freshell/.worktrees/gcloud-robot-conversion
npm ci --no-audit --no-fund
```

Expected: completes with exit 0 (`added N packages`). Needed because
`cloud-run-wrapper.test.sh` invokes real local Playwright and
`cloud-vitest-wrapper.test.sh` runs a real local vitest file; the
identity-suite runs them in turn. Not a coordinator-gated broad run.

---

### Task 1: Shared identity-ladder helper + hermetic ladder suite

Deliverable: `scripts/lib/gcp-identity.sh` — the single sourced home of the
skill's verbatim `resolve_gcp_identity` drop-in block plus the repo's thin
bridge — proven by the new suite `scripts/test/cloud-gcp-identity.test.sh`
(helper-level rung coverage). No wrapper changes yet; the suite's
wrapper-level block arrives in Task 2.

**Files:**
- Create: `scripts/lib/gcp-identity.sh` (sourced, mode 644 — no exec bit)
- Create: `scripts/test/cloud-gcp-identity.test.sh` (mode matches the existing
  suites: check `stat -c %a scripts/test/cloud-build.test.sh` and mirror it)
- Test: `scripts/test/cloud-gcp-identity.test.sh` (the suite is its own test)

**Interfaces:**
- Consumes: the gcloud-robot skill's drop-in contract (`GCLOUD_IDENT`,
  `GCLOUD_ROBOT_HOME`, `GCLOUD_ROBOT_REQUIRE`, `GCLOUD_ROBOT_PROJECT`,
  `GCLOUD_ROBOT_PROBE_PERMISSION`).
- Produces: `resolve_gcp_identity` (verbatim skill block) and
  `freshell_resolve_cloud_identity <probe-permission>` — returns 0 untouched
  when the caller's `GCP_ACCOUNT` is already pinned (rung 1 never touches the
  network or strict-mode failure paths); otherwise bridges the caller's
  `GCP_PROJECT` into `GCLOUD_ROBOT_PROJECT`, defaults
  `GCLOUD_ROBOT_PROBE_PERMISSION` from `$1`, resolves, applies a resulting
  `GCLOUD_IDENT` into `GCP_ACCOUNT`, and PROPAGATES the ladder's failure
  status. Used by both wrappers in Task 2.

- [ ] **Step 1: Write the failing behavioral test**

Create `scripts/test/cloud-gcp-identity.test.sh` with exactly this content
(task-1 state; Task 2 appends the wrapper-level block at the marked anchor):

```bash
#!/usr/bin/env bash
# Test: cloud-gcp-identity — hermetic coverage for the gcloud-robot identity
# ladder (scripts/lib/gcp-identity.sh) adopted by scripts/e2e-cloud.sh and
# scripts/vitest-cloud.sh. Covers every ladder rung (rung-1 repo pin respect,
# rung-2 GCLOUD_IDENT bypass, rung-3 probe via GCLOUD_ROBOT_HOME, rung-4
# quiet ambient fallback and GCLOUD_ROBOT_REQUIRE=1 fail-closed), bridge/env
# forwarding, operator overrides, and single-probe idempotency.
#
# ALWAYS hermetic: the probe branch drives an inert fake selector under a
# fake GCLOUD_ROBOT_HOME and every wrapper run uses a stubbed gcloud — no
# network, no real credentials, no real IAM answers (skill trap 11).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

HELPER="$ROOT/scripts/lib/gcp-identity.sh"
WRAPPER_E2E="$ROOT/scripts/e2e-cloud.sh"
WRAPPER_VITEST="$ROOT/scripts/vitest-cloud.sh"

FAILURES=0
check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== Cloud GCP identity ladder test ==="

TDIR="$(mktemp -d /tmp/cloud-gcp-identity.XXXXXX)"
trap 'rm -rf "$TDIR"' EXIT

# Inert stand-in for the gcloud-robot selector: records every invocation
# (proves the probe branch ran) plus the env contract it observed, then
# prints the caller-chosen account or takes the zero-candidate exit-1 path
# with empty stdout (its documented failure shape — see skill known-issues
# trap 11). Touches nothing but $TDIR; real curl/gcloud never run.
FAKE_HOME="$TDIR/robot-home"
mkdir -p "$FAKE_HOME/scripts"
cat > "$FAKE_HOME/scripts/select-gcloud-identity.sh" <<'FAKE_SELECTOR'
#!/usr/bin/env bash
echo ran >> "${SELECTOR_MARKER:?set SELECTOR_MARKER}"
echo "project=${GCLOUD_ROBOT_PROJECT:-} probe=${GCLOUD_ROBOT_PROBE_PERMISSION:-}" >> "${SELECTOR_MARKER}.env"
if [ "${SELECTOR_FAIL:-0}" = "1" ]; then exit 1; fi
printf '%s\n' "${SELECTOR_ACCOUNT:-}"
FAKE_SELECTOR
chmod +x "$FAKE_HOME/scripts/select-gcloud-identity.sh"

export SELECTOR_MARKER="$TDIR/selector-ran"
LADDER_STDERR="$TDIR/stderr"

# Reads one "key=value" outcome line out of a run_ladder transcript.
field() {
  grep "^$2=" <<< "$1" | head -1 | cut -d= -f2-
}

# Identity/ladder knobs scrubbed out of the harness environment before every
# ladder/wrapper invocation — an operator machine may legitimately export any
# of these (FRESHELL_GCP_ACCOUNT, GCLOUD_ROBOT_REQUIRE=1, a real
# GCLOUD_ROBOT_HOME, ...), and any leak would silently change which rung a
# check exercises. Every ladder/wrapper call below applies this list, then
# layers only the knobs the check intends.
SCRUB=(-u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE
       -u GCLOUD_ROBOT_PROJECT -u GCLOUD_ROBOT_PROBE_PERMISSION
       -u FRESHELL_GCP_ACCOUNT -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT
       -u SELECTOR_ACCOUNT -u SELECTOR_FAIL)

# Runs the identity ladder in a FRESH bash process over the scrubbed env;
# extra KEY=VALUE arguments are the check's intended knobs, forwarded to env.
# Stdout: rc/ident/account/pin outcome lines. Stderr from the ladder lands in
# $LADDER_STDERR. Resets the selector markers per run. Always returns 0: the
# ladder's own rc is reported as the rc= outcome line, so a subshell crash
# shows up as missing lines, not a set -e abort.
run_ladder() {
  local probe="$1"
  shift
  rm -f "$LADDER_STDERR" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  env "${SCRUB[@]}" "$@" bash -c '
    set -u
    . "$1"
    GCP_PROJECT="misc-puttering-project"
    GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
    if freshell_resolve_cloud_identity "$2"; then rc=0; else rc=$?; fi
    printf "rc=%s\n" "$rc"
    printf "ident=%s\n" "${GCLOUD_IDENT:-}"
    printf "account=%s\n" "${CLOUDSDK_CORE_ACCOUNT:-}"
    printf "pin=%s\n" "$GCP_ACCOUNT"
  ' _ "$HELPER" "$probe" 2>"$LADDER_STDERR" || true
}

# --- Check A: sourcing is silent and side-effect-free ---------------------
# help/local lanes source the helper unconditionally, so the source itself
# must never print, resolve, or require any env.
SRC_OUT=$(env "${SCRUB[@]}" bash -c \
  'set -u; . "$1" && declare -F resolve_gcp_identity >/dev/null && declare -F freshell_resolve_cloud_identity >/dev/null && echo sourced-ok' \
  _ "$HELPER" 2>&1 || true)
check "sourcing the helper defines both functions with zero output" \
  bash -c '[ "$1" = "sourced-ok" ]' _ "$SRC_OUT"

# --- Check B: rung 2 — explicit GCLOUD_IDENT bypass, no network -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="fake-bypass@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME")
check "rung-2 bypass: GCLOUD_IDENT flows to pin + exports, selector never runs, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "fake-bypass@example.invalid" ] &&
    [ "$3" = "fake-bypass@example.invalid" ] && [ "$4" = "fake-bypass@example.invalid" ] &&
    [ ! -e "$5" ] && [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check C: rung 3 — probe selects an account, env contract forwarded ---
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="gcloud-robot@example.invalid")
check "rung-3 probe: selector account adopted, project+probe env forwarded, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "gcloud-robot@example.invalid" ] &&
    [ "$3" = "gcloud-robot@example.invalid" ] && [ "$4" = "gcloud-robot@example.invalid" ] &&
    grep -q "project=misc-puttering-project probe=run.jobs.run" "$5.env" &&
    [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check D: probe finds nothing — quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1)
check "probe-empty: one ambient-fallback stderr note, no identity, exit 0" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] && [ -z "$3" ] && [ -z "$4" ] &&
    [ "$(wc -l < "$5")" = "1" ] &&
    grep -q "no probed identity; using ambient gcloud" "$5" &&
    [ -e "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check E: skill absent — single quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run")
check "skill-absent: exactly one ambient-fallback stderr note, exit 0" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$2" &&
    [ ! -e "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check F: strict mode fails closed when the skill is absent -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, skill absent: nonzero rc + strict-mode guidance" \
  bash -c '
    [ "$1" != "0" ] && grep -q "strict mode" "$2" && [ -z "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$(field "$OUT" account)"

# --- Check G: strict mode fails closed when the probe finds nothing -------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1 GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, probe empty: nonzero rc + probe failure named" \
  bash -c '
    [ "$1" != "0" ] && grep -q "no identity passes the probe" "$2"
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR"

# --- Check H: idempotent — a second resolve never re-runs the selector ----
rm -f "$SELECTOR_MARKER"
OUT=$(env "${SCRUB[@]}" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="once@example.invalid" \
      bash -c '
        set -u
        . "$1"
        GCP_PROJECT="misc-puttering-project"
        GCP_ACCOUNT=""
        freshell_resolve_cloud_identity "run.jobs.run"
        freshell_resolve_cloud_identity "cloudbuild.builds.create"
        printf "ident=%s\n" "$GCLOUD_IDENT"
      ' _ "$HELPER" 2>/dev/null || true)
check "two resolves in one process run the selector exactly once" \
  bash -c '
    [ "$1" = "once@example.invalid" ] && [ "$(wc -l < "$2")" = "1" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check I: operator-pinned GCLOUD_ROBOT_PROJECT survives the bridge ----
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="robot@example.invalid" \
      GCLOUD_ROBOT_PROJECT="other-project" GCLOUD_ROBOT_PROBE_PERMISSION="custom.perm.check")
check "operator overrides: project + probe pass through to the selector verbatim" \
  bash -c '
    grep -q "project=other-project probe=custom.perm.check" "$2.env" &&
    [ "$1" = "robot@example.invalid" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check J: rung 1 — a pinned GCP_ACCOUNT short-circuits the ladder -----
# A pin must win BEFORE any ladder work: no selector run (even with
# GCLOUD_ROBOT_HOME + GCLOUD_IDENT present), no CLOUDSDK exports, no stderr,
# and strict mode may not fail a pinned call. The ident transcript line still
# echoes the inherited env value — it is simply never consulted.
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="ident@example.invalid" \
      FRESHELL_GCP_ACCOUNT="pinned@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      GCLOUD_ROBOT_REQUIRE=1)
check "explicit account pin wins BEFORE the ladder (no probe, no exports, silent)" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "pinned@example.invalid" ] && [ -z "$3" ] &&
    [ ! -e "$4" ] && [ ! -s "$5" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" pin)" "$(field "$OUT" account)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# WRAPPER-LEVEL-CHECKS-ANCHOR (Task 2 appends here)

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL because `scripts/lib/gcp-identity.sh` does not exist — sourcing
a missing file aborts each subshell, so Check A's `declare -F` never runs and
every `run_ladder` transcript is empty (all `field` extractions come back
empty). All ten checks report FAIL and the suite exits 1. (This is
missing-behavior failure, not a syntax accident: the suite parses and runs to
completion, and Check A fails non-vacuously — its expected `sourced-ok`
marker never appears.)

- [ ] **Step 3: Add the minimal production implementation**

Create `scripts/lib/gcp-identity.sh` with exactly this content. The drop-in
block between the BEGIN/END markers is the skill's verbatim text — composed
against the "identity ladder" section of the operator's installed
gcloud-robot skill's SKILL.md (located wherever the operator's platform
keeps installed skills, or via `GCLOUD_ROBOT_HOME` once set — never recorded
in-commit). If any drift is suspected at execution time, re-copy the block
from that source and keep the repo copy byte-identical:

```bash
#!/usr/bin/env bash
# gcp-identity.sh — shared gcloud identity ladder for Freshell's GCP lanes
# (scripts/e2e-cloud.sh, scripts/vitest-cloud.sh).
#
# THIS FILE IS SOURCED, NOT EXECUTED. It only defines functions — no
# top-level side effects, no output, no network — so every lane, including
# `help` and local runs on machines with no gcloud and no skill installed,
# may source it unconditionally.
#
# resolve_gcp_identity below is the gcloud-robot skill's drop-in block,
# copied VERBATIM. Do not hand-edit it: the rung ordering and the
# ambient-default / strict-opt-in behavior are load-bearing. The skill
# itself is never vendored or referenced by path; this block is the single
# permitted copy, and run-time discovery of the selector happens only via
# GCLOUD_ROBOT_HOME.
#
# Ladder (fixed order):
#   1. A call-site / repo pin (the wrapper's --account= or FRESHELL_GCP_ACCOUNT)
#      is never overridden — the bridge below only fills an EMPTY pin var.
#   2. GCLOUD_IDENT set: use verbatim, no probe, no network.
#   3. Probe: $GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh picks a
#      credentialed account that passes the lane's live permission probe.
#   4. Ambient fallback (default): one quiet stderr note, gcloud runs exactly
#      as before adoption. GCLOUD_ROBOT_REQUIRE=1 turns rung 4 into
#      fail-closed-with-guidance (hardening/CI).

# --- BEGIN verbatim drop-in block (gcloud-robot skill) --------------------
resolve_gcp_identity() {
  [ -n "${GCLOUD_IDENT_RESOLVED:-}" ] && return 0; GCLOUD_IDENT_RESOLVED=1
  export GCLOUD_ROBOT_PROJECT="${GCLOUD_ROBOT_PROJECT:?set GCLOUD_ROBOT_PROJECT}"
  export GCLOUD_ROBOT_PROBE_PERMISSION="${GCLOUD_ROBOT_PROBE_PERMISSION:?set GCLOUD_ROBOT_PROBE_PERMISSION (lane representative permission)}"
  if [ -n "${GCLOUD_IDENT:-}" ]; then
    :                                                          # rung 2: explicit bypass, no network
  elif [ -n "${GCLOUD_ROBOT_HOME:-}" ] && [ -x "$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh" ]; then
    GCLOUD_IDENT="$(bash "$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh" 2>/dev/null)" || GCLOUD_IDENT=""
    if [ -z "$GCLOUD_IDENT" ] && [ -n "${GCLOUD_ROBOT_REQUIRE:-}" ]; then
      echo "gcloud-robot: no identity passes the probe on $GCLOUD_ROBOT_PROJECT (strict mode)" >&2
      return 1
    fi
    [ -z "$GCLOUD_IDENT" ] && echo "gcloud-robot: no probed identity; using ambient gcloud" >&2
  elif [ -n "${GCLOUD_ROBOT_REQUIRE:-}" ]; then
    echo "gcloud-robot: skill not found at ${GCLOUD_ROBOT_HOME:-<unset>}... (strict mode)" >&2
    return 1                                                   # rung 4: fail closed (opt-in)
  else
    echo "gcloud-robot: skill not found at ${GCLOUD_ROBOT_HOME:-<unset>} — using ambient gcloud (set GCLOUD_ROBOT_HOME to get robot identity)" >&2
  fi
  if [ -n "${GCLOUD_IDENT:-}" ]; then
    export CLOUDSDK_CORE_ACCOUNT="$GCLOUD_IDENT" CLOUDSDK_CORE_PROJECT="$GCLOUD_ROBOT_PROJECT"
  fi
}
# --- END verbatim drop-in block --------------------------------------------
# Nesting rule (from the skill): never write ${...:?...} messages with
# apostrophes — bash parses the ${} interior as its own quoting context.

# freshell_resolve_cloud_identity bridges a wrapper's settings into the
# ladder and applies a probed identity to the wrapper's pinned account var.
#
#   $1 = this lane's representative probe permission (the permission that
#        gates the lane's real work): "cloudbuild.builds.create" for the
#        build/push lane, "run.jobs.run" for the run and logs lanes.
#
# Call it LAZILY — immediately before a cloud lane's first real gcloud call,
# after flag parsing — so help/local lanes never touch GCP tooling. The
# ladder's own guard makes repeat calls free (single probe per process).
#
# Requires the caller to provide GCP_PROJECT and GCP_ACCOUNT (possibly
# empty), matching both cloud wrappers' top-of-file defaults.
freshell_resolve_cloud_identity() {
  # rung 1: an existing pin (the wrapper's --account= flag or
  # FRESHELL_GCP_ACCOUNT) wins outright — skip the ladder ENTIRELY: no
  # selector, no network, no stderr note, and GCLOUD_ROBOT_REQUIRE=1 must not
  # fail a deliberately pinned call.
  if [ -n "${GCP_ACCOUNT:-}" ]; then return 0; fi
  export GCLOUD_ROBOT_PROJECT="${GCLOUD_ROBOT_PROJECT:-${GCP_PROJECT:?GCP_PROJECT must be set before identity resolution}}"
  export GCLOUD_ROBOT_PROBE_PERMISSION="${GCLOUD_ROBOT_PROBE_PERMISSION:-${1:?probe permission argument required}}"
  # Propagate the ladder's status: under GCLOUD_ROBOT_REQUIRE=1 a failed
  # resolve must fail the lane (both wrappers run set -e; the ladder already
  # printed its guidance).
  if ! resolve_gcp_identity; then return 1; fi
  # Pinned-call adoption (gcloud-robot skill): a probed identity takes the
  # pinned --account slot (the pin was empty, per the rung-1 branch above).
  # With nothing resolved the pin stays empty and the wrappers omit
  # --account entirely, letting ambient gcloud apply (the ladder already
  # noted that on stderr).
  GCP_ACCOUNT="${GCLOUD_IDENT:-}"
}
```

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS — all ten checks (A–J) print PASS and the footer prints
`=== All checks passed ===` (exit 0).

- [ ] **Step 5: Refactor while green**

No refactor: the helper is the skill's verbatim block plus a deliberately
minimal bridge, and the suite is new and self-contained (the `field()` +
`run_ladder` helpers are the dedup point — checks carry no repeated command
pipelines).

- [ ] **Step 6: Run impacted-test verification**

The helper is new and sourced by nothing yet, so no existing behavior can be
affected; the impacted set is the new suite plus the four existing cloud
suites proving untouched base behavior:

Run:
```bash
for t in scripts/test/cloud-gcp-identity.test.sh \
         scripts/test/cloud-build.test.sh \
         scripts/test/cloud-exec-id-parse.test.sh \
         scripts/test/cloud-vitest-wrapper.test.sh \
         scripts/test/cloud-run-wrapper.test.sh; do
  bash "$t" || { echo "SUITE FAILED: $t"; exit 1; }
done
```

Expected: PASS — every suite exits 0. (Runtime note: cloud-run-wrapper runs
real local Playwright several times; allow a few minutes.)

- [ ] **Step 7: Commit the task**

```bash
git add scripts/lib/gcp-identity.sh scripts/test/cloud-gcp-identity.test.sh
git commit -m "feat(cloud): add gcloud-robot identity ladder helper + hermetic ladder suite"
```

---

### Task 2: Wire the identity ladder into both cloud wrappers

Deliverable: `scripts/e2e-cloud.sh` and `scripts/vitest-cloud.sh` resolve
their gcloud identity through the shared helper, lazily per cloud lane, with
the hardcoded human default removed; the four pre-existing stubbed suites
gain their trap-11 pins; the identity suite gains wrapper-level coverage for
the whole precedence chain on the real wrappers. Both wrappers receive the
same wiring — the helper is the single dedup point, so the edits are small
and mirrored (every hunk is still spelled out per file below).

**Files:**
- Modify: `scripts/e2e-cloud.sh` (hunks E1–E11; anchors verified at base
  530f5f35: default at line 45, source point after 56, helpers 94–114,
  cmd_build 191, cmd_push 220, cmd_run 364/367, submit 208, token 231,
  describe 392–393, cmd_logs 575, usage 136/140–142, header comment 29)
- Modify: `scripts/vitest-cloud.sh` (hunks V1–V11; same shape: default 43,
  source after 54, helpers 91–112, cmd_build 187, cmd_push 216, cmd_run
  345/347, submit 204–205, token 226, describe 376, cmd_logs 544, usage
  133/137–139, header comment 28)
- Modify: `scripts/test/cloud-build.test.sh` (pin after line 7 `cd "$ROOT"`)
- Modify: `scripts/test/cloud-exec-id-parse.test.sh` (pin after line 18)
- Modify: `scripts/test/cloud-run-wrapper.test.sh` (pin after line 7)
- Modify: `scripts/test/cloud-vitest-wrapper.test.sh` (pin after line 8)
- Modify: `scripts/test/cloud-gcp-identity.test.sh` (append the wrapper-level
  block at the `WRAPPER-LEVEL-CHECKS-ANCHOR`)

**Interfaces:**
- Consumes: `freshell_resolve_cloud_identity` and `resolve_gcp_identity` from
  Task 1's `scripts/lib/gcp-identity.sh` (sourced via `$SCRIPT_DIR/lib/`).
- Produces: wrapper-local `account_flag()`, the conditional `gcloud_flags()` /
  `gcloud_artifacts_flags()`, and the no-human-default `GCP_ACCOUNT`
  lifecycle (`--account=` > `FRESHELL_GCP_ACCOUNT` > ladder > omitted).

#### Wrapper edit reference (apply E1–E11 to e2e-cloud.sh; V1–V11 mirror to vitest-cloud.sh)

**E1 / V1 — remove the hardcoded default.** e2e-cloud.sh:45
`GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-dan@danshapiro.com}"` /
vitest-cloud.sh:43 (same line) become:

```bash
# No account is hardcoded. Precedence: --account= flag > FRESHELL_GCP_ACCOUNT
# > gcloud-robot identity ladder (freshell_resolve_cloud_identity, resolved
# lazily per cloud lane) > unset — calls then omit --account and ambient
# gcloud applies, which the ladder announces once on stderr.
GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
```

**E2 / V2 — source the helper.** Immediately after the `SCRIPT_DIR`/`ROOT`
lines (e2e-cloud.sh:55-56 / vitest-cloud.sh:53-54):

```bash
# Shared gcloud identity ladder (gcloud-robot). Sourcing only defines
# functions — no side effects, no output — so help and local lanes stay
# gcloud-free and silent.
# shellcheck source=scripts/lib/gcp-identity.sh
. "$SCRIPT_DIR/lib/gcp-identity.sh"
```

**E3 / V3 — conditional account in the two flag helpers, plus `account_flag()`.**
e2e-cloud.sh:94-96 / vitest-cloud.sh:91-93 (`gcloud_flags`) and
e2e-cloud.sh:112-114 / vitest-cloud.sh:110-112 (`gcloud_artifacts_flags`)
become (region vs location kept as-is per helper), followed by the new
`account_flag`:

```bash
gcloud_flags() {
  # No identity may legitimately resolve (rung 4: ambient gcloud). An empty
  # pin omits --account entirely rather than passing gcloud an empty value.
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --region=${GCP_REGION}"
  else
    echo "--project=${GCP_PROJECT} --region=${GCP_REGION}"
  fi
}
```

```bash
# gcloud artifacts commands use --location, not --region
gcloud_artifacts_flags() {
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --location=${GCP_REGION}"
  else
    echo "--project=${GCP_PROJECT} --location=${GCP_REGION}"
  fi
}

# Prints a pinned --account flag, or NOTHING (not even an empty word) when no
# identity resolved — for the gcloud calls that pin inline instead of via
# gcloud_flags(). An empty expansion inside an unquoted $() yields no argv
# word, which is exactly what "omit --account" needs; always exits 0.
account_flag() {
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    printf -- '--account=%s' "${GCP_ACCOUNT}"
  fi
}
```

**E4 / V4 — resolve in `cmd_build`.** Immediately before the
`# Content-addressed tag` block comment (e2e-cloud.sh:191 /
vitest-cloud.sh:187), after the flag-parse loop:

```bash
  # Identity ladder (build/push lane): resolve before the first gcloud call,
  # never at script top — help and local-only paths must keep working with
  # zero GCP tooling. Probe = the lane's gating permission.
  freshell_resolve_cloud_identity "cloudbuild.builds.create"
```

**E5 / V5 — resolve in `cmd_push`.** As the first statement after the
"Building"/"Pushing" banner (e2e-cloud.sh after :220 `echo "[e2e-cloud]
Pushing to Artifact Registry..."` / vitest-cloud.sh after :216
`echo "[vitest-cloud] Pushing to Artifact Registry..."`):

```bash
  # A standalone `push` reaches gcloud without passing through cmd_build;
  # resolve idempotently (free when cmd_build already did).
  freshell_resolve_cloud_identity "cloudbuild.builds.create"
```

**E6 / V6 — resolve in `cmd_run`'s cloud branch.** After the local branch
closes (e2e-cloud.sh: the `fi` after the `exec npx playwright test` block at
:364 / vitest-cloud.sh: the `fi` after `exit "$exit_code"` at :345) and before
the `# Recompute the remote ref` comment:

```bash
  # Identity ladder (run lane): resolve before the image describe / build /
  # job calls below. `run --local` never reaches here (it exec'd or exited
  # above), so the local lane stays free of GCP tooling and of the ladder's
  # stderr note.
  freshell_resolve_cloud_identity "run.jobs.run"
```

**E7 / V7 — drop the inline pin on `builds submit`.**
e2e-cloud.sh:206-211 / vitest-cloud.sh:202-207:

```bash
    gcloud builds submit \
      --config "$ROOT/docker/cloud-run/cloudbuild.yaml" \
      $(account_flag) \
      --project="$GCP_PROJECT" \
      --substitutions=_IMAGE="${remote_base}:${tag}" \
      "$ROOT"
```

**E8 / V8 — drop the inline pin on `print-access-token`.**
e2e-cloud.sh:231 / vitest-cloud.sh:226:

```bash
  gcloud auth print-access-token $(account_flag) | \
    docker login -u oauth2accesstoken --password-stdin \
      "https://${GCP_REGION}-docker.pkg.dev"
```

An omitted `--account` here lets gcloud resolve ambient credentials for token
minting; a missing ambient account surfaces gcloud's own reauthentication
error, which the ladder's stderr note has already contextualized.

**E9 / V9 — drop the inline pin on the image-existence probe.**
e2e-cloud.sh:392-393:

```bash
  elif ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      $(account_flag) --project="$GCP_PROJECT" &>/dev/null 2>&1; then
```

vitest-cloud.sh:376-377:

```bash
  if ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      $(account_flag) --project="$GCP_PROJECT" &>/dev/null 2>&1; then
```

(The `elif`/`if` difference is the wrappers' existing structure; keep it.)

**E10 / V10 — resolve in `cmd_logs`.** First statement of `cmd_logs`
(e2e-cloud.sh before :575 `local execution_id` / vitest-cloud.sh before
:544):

```bash
  # logs is a cloud-only lane (executions list + logs read); resolve before
  # the first gcloud call.
  freshell_resolve_cloud_identity "run.jobs.run"
```

**E11 / V11 — help + header text.** e2e-cloud.sh:29 header line and
e2e-cloud.sh usage(); vitest-cloud.sh:28 header line and
vitest-cloud.sh usage(). Header comment `--account` line becomes:

```
#   --account=EMAIL   GCP account pin (highest precedence; default: none —
#                     FRESHELL_GCP_ACCOUNT env, then the gcloud-robot identity
#                     ladder, then ambient gcloud)
```

usage() `--account` line becomes:

```
  --account=EMAIL   GCP account pin (highest precedence; default: none)
```

and the usage() `Environment:` block gains the knob documentation (e2e
version shown; vitest version identical except `FRESHELL_E2E_BACKEND` →
`FRESHELL_VITEST_BACKEND` and `FRESHELL_GCP_JOB` → `FRESHELL_GCP_VITEST_JOB`):

```
Environment:
  FRESHELL_E2E_BACKEND  "local" (default) or "cloud"
  FRESHELL_GCP_JOB      Cloud Run job-name prefix (default: freshell-e2e)
  FRESHELL_GCP_ACCOUNT  GCP account override pinned on every gcloud call (optional)

Identity (cloud lanes only — details: docs/development/gcloud-robot.md):
  Cloud subcommands resolve a gcloud identity lazily, in this order:
  --account= > FRESHELL_GCP_ACCOUNT > GCLOUD_IDENT > gcloud-robot probe
  (needs GCLOUD_ROBOT_HOME, the installed gcloud-robot skill directory)
  > ambient gcloud (one quiet stderr note). GCLOUD_ROBOT_REQUIRE=1 fails
  closed with guidance instead of the ambient fallback.
```

#### Trap-11 pins for the four pre-existing suites

Insert immediately after each suite's `cd "$ROOT"` line
(cloud-build.test.sh:7, cloud-run-wrapper.test.sh:7,
cloud-vitest-wrapper.test.sh:8, cloud-exec-id-parse.test.sh:18), identical in
all four:

```bash
# gcloud-robot hermeticity pin (skill trap 11): the wrappers now carry a live
# identity ladder. Pinning GCLOUD_IDENT forces the ladder's rung-2 bypass, so
# no wrapper invocation from this suite can reach the real probe/network —
# even if the harness environment happens to export GCLOUD_ROBOT_HOME. The
# value is deliberately fake; nothing in this suite depends on it.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"
```

#### Identity-suite wrapper-level block (appended at `WRAPPER-LEVEL-CHECKS-ANCHOR`)

```bash
# ---------------------------------------------------------------------------
# Wrapper-level: the ladder drives --account on REAL wrapper cloud runs
# (stubbed gcloud/docker; green-run shape mirrors cloud-exec-id-parse.test.sh).
# ---------------------------------------------------------------------------
echo "--- Wrapper-level identity checks ---"

GTDIR="$TDIR/gcloud-stub"
mkdir -p "$GTDIR"
GREEN_LOG="$TDIR/green-gcloud.log"

# Green-run fake gcloud. images describe reports the image MISSING (exit 1)
# so every run also crosses the build lane (builds submit stubbed); the job
# lifecycle succeeds for any --shards value. Records every argv in $GREEN_LOG
# and every --account token (one per line) in $GREEN_LOG.accounts — an ABSENT
# accounts file is the proof that every call omitted --account.
cat > "$GTDIR/gcloud" <<'GREEN_FAKE'
#!/usr/bin/env bash
echo "GCLOUD_ARGS: $*" >> "${GREEN_LOG:?set GREEN_LOG}"
grep -oP -- '--account=\S+' <<< "$*" >> "${GREEN_LOG}.accounts" 2>/dev/null || true
if [[ "$*" == *"info"* ]]; then echo "/nonexistent-sdk-root"; exit 0; fi
if [[ "$*" == *"artifacts docker images describe"* ]]; then exit 1; fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then exit 0; fi
if [[ "$*" == *"artifacts repositories create"* ]]; then exit 0; fi
if [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo stub-token; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Execution [green-exec-1] has successfully completed."; exit 0; fi
if [[ "$*" == *"executions list"* ]]; then echo "green-exec-1"; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then
    N=$(grep -oP -- '--tasks=\K[0-9]+' "${GREEN_LOG}" | tail -1)
    echo "${N:-1}"
  else
    echo "0"
  fi
  exit 0
fi
if [[ "$*" == *"logs read"* ]]; then echo "  1 passed (1.0s)"; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
GREEN_FAKE
cat > "$GTDIR/docker" <<'GREEN_DOCKER'
#!/usr/bin/env bash
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
exit 0
GREEN_DOCKER
chmod +x "$GTDIR/gcloud" "$GTDIR/docker"

# Distinctive values per rung and pin source so the accounts log proves
# WHICH token won, never just that some token appeared.
RUNG2_IDENT="rung2-bypass@example.invalid"
RUNG3_ROBOT="rung3-robot@example.invalid"
FLAG_ACCOUNT="flag-wins@example.invalid"
ENV_ACCOUNT="env-wins@example.invalid"

reset_green() {
  rm -f "$GREEN_LOG" "$GREEN_LOG.accounts" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  touch "$GREEN_LOG"
}

# Every gcloud invocation that COULD pin an account DID pin this exact one:
# the accounts log must contain one token per logged gcloud call (the bare
# `gcloud info` PATH-probe call takes no flags and is excluded), all equal to
# the expected value, and non-empty — an omit/present mix or an empty log
# both fail.
accounts_all_equal() {
  [ -s "$GREEN_LOG.accounts" ] || return 1
  local calls tokens
  calls=$(grep '^GCLOUD_ARGS:' "$GREEN_LOG" | grep -vc '^GCLOUD_ARGS: info ')
  tokens=$(wc -l < "$GREEN_LOG.accounts")
  [ "$calls" -gt 0 ] && [ "$calls" -eq "$tokens" ] && \
    [ "$(sort -u "$GREEN_LOG.accounts" | wc -l)" = "1" ] && \
    [ "$(sort -u "$GREEN_LOG.accounts" | head -1)" = "--account=$1" ]
}

# --- W1: e2e rung 2 — GCLOUD_IDENT drives every pinned call ----------------
reset_green
W1_ERR="$TDIR/w1.err"
W1_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>"$W1_ERR") && W1_RC=0 || W1_RC=$?
check "W1 e2e rung-2: run succeeds with GCLOUD_IDENT pinned on every call, selector untouched, silent" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -s "$3" ]
  ' _ "$W1_RC" "$W1_OUT" "$W1_ERR"
check "W1 e2e rung-2: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W1 e2e rung-2: selector never ran and no hardcoded human account appeared" \
  bash -c '[ ! -e "$1" ] && ! grep -q "dan@danshapiro" "$2"' _ "$SELECTOR_MARKER" "$GREEN_LOG"

# --- W2: e2e rung 1 — a flag pin wins BEFORE the ladder runs --------------
reset_green
W2_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" FRESHELL_GCP_ACCOUNT="$ENV_ACCOUNT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 --account="$FLAG_ACCOUNT" 2>/dev/null) && W2_RC=0 || W2_RC=$?
check "W2 e2e rung-1: --account= flag wins over env and ladder" \
  bash -c '[ "$1" = "0" ]' _ "$W2_RC"
check "W2 e2e rung-1: every gcloud call pinned to the flag value" \
  accounts_all_equal "$FLAG_ACCOUNT"
check "W2 e2e rung-1: the ladder never ran for a pinned call (no probe, even with HOME set)" \
  bash -c '[ ! -e "$1" ]' _ "$SELECTOR_MARKER"

# --- W3: e2e rung 1b — FRESHELL_GCP_ACCOUNT wins BEFORE the ladder --------
reset_green
W3_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" FRESHELL_GCP_ACCOUNT="$ENV_ACCOUNT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null) && W3_RC=0 || W3_RC=$?
check "W3 e2e env-pin: FRESHELL_GCP_ACCOUNT wins over the ladder" \
  bash -c '[ "$1" = "0" ]' _ "$W3_RC"
check "W3 e2e env-pin: every gcloud call pinned to the env value" \
  accounts_all_equal "$ENV_ACCOUNT"
check "W3 e2e env-pin: the ladder never ran for a pinned call" \
  bash -c '[ ! -e "$1" ]' _ "$SELECTOR_MARKER"

# --- W4: e2e rung 3 — the probe result takes the pinned slot ---------------
reset_green
W4_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" \
         GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="$RUNG3_ROBOT" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null) && W4_RC=0 || W4_RC=$?
check "W4 e2e rung-3: probed identity pins every call; selector ran once w/ lane probe" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "project=misc-puttering-project probe=run.jobs.run" "$2.env"
  ' _ "$W4_RC" "$SELECTOR_MARKER"
check "W4 e2e rung-3: every gcloud call pinned to the probed robot" \
  accounts_all_equal "$RUNG3_ROBOT"

# --- W5: e2e rung 4 — nothing resolves: --account omitted, one note ---------
reset_green
W5_ERR="$TDIR/w5.err"
W5_OUT=$(env "${SCRUB[@]}" \
         PATH="$GTDIR:$PATH" "$WRAPPER_E2E" run --cloud --shards=1 2>"$W5_ERR") && W5_RC=0 || W5_RC=$?
check "W5 e2e ambient: run succeeds, --account omitted everywhere, one ambient note" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] &&
    [ "$(wc -l < "$4")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$4"
  ' _ "$W5_RC" "$W5_OUT" "$GREEN_LOG.accounts" "$W5_ERR"

# --- W6: vitest parity — rung-2 pin and rung-4 omission -------------------
reset_green
W6A_ERR="$TDIR/w6a.err"
W6A_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" \
          GCLOUD_IDENT="$RUNG2_IDENT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
          "$WRAPPER_VITEST" run --cloud --config=default --shards=2 2>"$W6A_ERR") && W6A_RC=0 || W6A_RC=$?
check "W6a vitest rung-2: succeeds, every call pinned to GCLOUD_IDENT, selector untouched" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] && [ ! -s "$4" ]
  ' _ "$W6A_RC" "$W6A_OUT" "$SELECTOR_MARKER" "$W6A_ERR"
check "W6a vitest rung-2: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"

reset_green
W6B_ERR="$TDIR/w6b.err"
W6B_OUT=$(env "${SCRUB[@]}" \
          PATH="$GTDIR:$PATH" "$WRAPPER_VITEST" run --cloud --config=default --shards=2 2>"$W6B_ERR") && W6B_RC=0 || W6B_RC=$?
check "W6b vitest ambient: run succeeds, --account omitted everywhere, one ambient note" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] &&
    [ "$(wc -l < "$4")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$4"
  ' _ "$W6B_RC" "$W6B_OUT" "$GREEN_LOG.accounts" "$W6B_ERR"

# --- W7: the four pre-existing stubbed suites are probe-proof (trap 11) ----
# Each pins GCLOUD_IDENT, so running them under a marker-trap
# GCLOUD_ROBOT_HOME whose selector would FAIL must leave the marker untouched
# AND the suites green: no nested wrapper invocation may reach the probe.
# The scrub keeps any harness-level ladder knobs from leaking in and
# invalidating the pin experiment.
for nested in scripts/test/cloud-build.test.sh \
              scripts/test/cloud-exec-id-parse.test.sh \
              scripts/test/cloud-vitest-wrapper.test.sh \
              scripts/test/cloud-run-wrapper.test.sh; do
  rm -f "$SELECTOR_MARKER"
  env "${SCRUB[@]}" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1 \
    bash "$nested" >"$TDIR/nested.log" 2>&1 && NESTED_RC=0 || NESTED_RC=$?
  check "W7 trap-11: $nested green and probe-free under hostile GCLOUD_ROBOT_HOME" \
    bash -c '[ "$1" = "0" ] && [ ! -e "$2" ]' _ "$NESTED_RC" "$SELECTOR_MARKER"
done

# --- W8: help works with no gcloud, no account, fake HOME — and silently ---
CLEAN_PATH="$PATH"
if GCLOUD_PATH_RESOLVED=$(command -v gcloud 2>/dev/null); then
  GCLOUD_DIRNAME="$(cd "$(dirname "$GCLOUD_PATH_RESOLVED")" && pwd)"
  CLEAN_PATH="$(echo "$PATH" | tr ':' '\n' | grep -vx "$GCLOUD_DIRNAME" | paste -sd:)"
  if [ "$CLEAN_PATH" = "$PATH" ]; then
    echo "FAIL: could not construct a gcloud-free PATH (gcloud dir not on PATH?)"
    FAILURES=$((FAILURES + 1))
    CLEAN_PATH=""
  fi
fi
if [ -n "$CLEAN_PATH" ]; then
  if env PATH="$CLEAN_PATH" command -v gcloud >/dev/null 2>&1; then
    echo "FAIL: gcloud still resolvable on the filtered PATH"
    FAILURES=$((FAILURES + 1))
  else
    for wrapper_pair in "E2E:$WRAPPER_E2E" "VITEST:$WRAPPER_VITEST"; do
      lane="${wrapper_pair%%:*}"
      wrapper="${wrapper_pair#*:}"
      rm -f "$SELECTOR_MARKER"
      HELP_OUT=$(env "${SCRUB[@]}" PATH="$CLEAN_PATH" \
        GCLOUD_ROBOT_HOME="$FAKE_HOME" \
        "$wrapper" help 2>&1) && HELP_RC=0 || HELP_RC=$?
      check "W8 $lane help: exit 0, prints usage, no identity activity, silent" \
        bash -c '
          [ "$1" = "0" ] && grep -qi "usage" <<<"$2" &&
          ! grep -q "gcloud-robot" <<<"$2" && [ ! -e "$3" ]
        ' _ "$HELP_RC" "$HELP_OUT" "$SELECTOR_MARKER"
    done
  fi
fi

# --- W9: the vitest local lane never wakes the ladder ----------------------
rm -f "$SELECTOR_MARKER"
W9_OUT=$(env "${SCRUB[@]}" \
         GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_VITEST" run --local --config=default test/unit/lib/pane-utils.test.ts 2>&1) \
  && W9_RC=0 || W9_RC=$?
check "W9 vitest --local: runs real local vitest, no selector, no ladder output" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -qE "Test Files|passed" <<<"$2" &&
    ! grep -q "gcloud-robot" <<<"$2" && [ ! -e "$3" ]
  ' _ "$W9_RC" "$W9_OUT" "$SELECTOR_MARKER"

# --- W10/W11: help documents every identity knob, no human default ---------
E2E_HELP=$("$WRAPPER_E2E" help 2>&1)
VITEST_HELP=$("$WRAPPER_VITEST" help 2>&1)
for knob in GCLOUD_IDENT GCLOUD_ROBOT_HOME GCLOUD_ROBOT_REQUIRE FRESHELL_GCP_ACCOUNT; do
  check "W10 e2e help mentions $knob" bash -c 'grep -q "$1" <<<"$2"' _ "$knob" "$E2E_HELP"
  check "W11 vitest help mentions $knob" bash -c 'grep -q "$1" <<<"$2"' _ "$knob" "$VITEST_HELP"
done
check "W10 e2e help carries no hardcoded human account" \
  bash -c '! grep -q "dan@danshapiro" <<<"$1"' _ "$E2E_HELP"
check "W11 vitest help carries no hardcoded human account" \
  bash -c '! grep -q "dan@danshapiro" <<<"$1"' _ "$VITEST_HELP"

# DOC-CHECKS-ANCHOR (Task 3 appends here)
```

- [ ] **Step 1: Extend the failing behavioral test**

Append the wrapper-level block above to `scripts/test/cloud-gcp-identity.test.sh`,
replacing the `# WRAPPER-LEVEL-CHECKS-ANCHOR (Task 2 appends here)` line.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL against the not-yet-wired wrappers, with exactly this failure
profile (derived from the wrappers' pre-wiring behavior — they pin the
hardcoded human account on every flagged call, so the accounts log is FULL
of `dan@danshapiro.com`, never empty):

- W1 fails its pin assertions (every call is pinned — to the hardcoded
  human, not the `GCLOUD_IDENT` value; and the no-hardcoded-human grep
  fires). Its run-success sub-check passes (the green stub run worked
  before, too).
- W4 fails (the marker-trap selector never runs pre-wiring — no ladder
  exists; and the accounts mismatch).
- W5 and W6b fail (accounts log is NOT absent — calls pin the human — and
  the ambient-fallback note does not exist).
- W6a fails (accounts mismatch, as W1).
- W10/W11 fail (help documents none of the knobs and still names the
  hardcoded default).
- W2/W3 PASS pre-wiring and must stay green (flag/env already win — the
  refactor preserves that; their new "the ladder never ran for a pinned
  call" assertions pass vacuously pre-wiring and become live after wiring,
  where they guard the rung-1 short-circuit).
- W7 and W8/W9's silence assertions pass vacuously pre-wiring (no ladder
  exists to trigger the trap); W7's red proof is the step-3 interim run
  below.

- [ ] **Step 3: Add the minimal production implementation — wrapper wiring only**

Apply hunks E1–E11 to `scripts/e2e-cloud.sh` and V1–V11 to
`scripts/vitest-cloud.sh` per the edit reference above. Do NOT yet add the
four trap-11 pins.

Interim verification (the pins' red proof): run
`bash scripts/test/cloud-gcp-identity.test.sh` and confirm W1–W6, W8–W11 are
now GREEN while **W7 is RED with `$SELECTOR_MARKER` written** — the nested
suites invoked the wired wrappers, the ladder reached rung 3, and the
marker-trap selector ran: exactly the trap-11 network-reachability hazard,
caught hermetically. Record the marker's existence, then proceed.

- [ ] **Step 4: Add the trap-11 pins and re-run**

Add the pin block to all four pre-existing suites (anchor: after each
`cd "$ROOT"`). Run:

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS — every check (helper-level A–J, wrapper-level W1–W11) passes
and the footer prints `=== All checks passed ===` (exit 0). Runtime note:
W7's nested `cloud-run-wrapper.test.sh` runs real local Playwright several
times; allow a few minutes for the full suite.

- [ ] **Step 5: Refactor while green**

None. The ladder itself is deduplicated through the shared helper by design;
the remaining mirror-structure edits (flag helpers, `account_flag`, three
one-line resolve calls per wrapper) match the wrappers' established parallel
layout — collapsing them would diverge from the repo's existing structure
without removing real duplication. No repo-configured shell lint covers these
wrappers; do a visual consistency pass on the two diffs instead
(`git diff scripts/e2e-cloud.sh scripts/vitest-cloud.sh`) and confirm the
hunks mirror each other apart from names/line placement.

- [ ] **Step 6: Run impacted-test verification**

Both wrappers changed and all six suites exercise them; the impacted set is
the full cloud-suite loop:

Run:
```bash
for t in scripts/test/cloud-gcp-identity.test.sh \
         scripts/test/cloud-build.test.sh \
         scripts/test/cloud-exec-id-parse.test.sh \
         scripts/test/cloud-vitest-wrapper.test.sh \
         scripts/test/cloud-run-wrapper.test.sh; do
  bash "$t" || { echo "SUITE FAILED: $t"; exit 1; }
done
```

Expected: PASS — every suite exits 0. (No TypeScript sources changed, so the
vitest/tsc lanes are structurally unaffected; their regression coverage
arrives via the workflow's coordinated suite at the stage gate.)

- [ ] **Step 7: Commit the task**

```bash
git add scripts/e2e-cloud.sh scripts/vitest-cloud.sh \
        scripts/test/cloud-build.test.sh scripts/test/cloud-exec-id-parse.test.sh \
        scripts/test/cloud-run-wrapper.test.sh scripts/test/cloud-vitest-wrapper.test.sh \
        scripts/test/cloud-gcp-identity.test.sh
git commit -m "feat(cloud): wire gcloud-robot identity ladder into e2e/vitest cloud wrappers"
```

---

### Task 3: Operator runbook + AGENTS.md identity sections

Deliverable: `docs/development/gcloud-robot.md` — the operator runbook
(robot identity, provisioning checklist, verification, rotation, revocation,
monitoring, both adoption states) — plus the mandatory AGENTS.md updates in
the two cloud-backend sections.

TDD shape: this is a docs-only task and the repo's TDD rule explicitly
exempts doc changes ("all changes but the most trivial (e.g. doc changes)").
Round-1 plan review reinforced this: the originally-planned D1–D5 checks
greped docs for expected phrases/links, which the repo's own test-quality
bar rules out as behavioral protection, so they were REMOVED — Task 3
carries no new suite content, and its verification is the review-through
checklist plus the existing-suite regression sweep below. The identity
suite's trailing `# DOC-CHECKS-ANCHOR (Task 3 appends here)` line from
Task 2 is deleted by this task (nothing ever appended).

**Files:**
- Create: `docs/development/gcloud-robot.md`
- Modify: `AGENTS.md` (one Identity paragraph appended to each of
  `### Vitest Test Backend (Cloud Run Jobs)` and `### E2E Test Backend
  (Cloud Run Jobs)`)
- Modify: `scripts/test/cloud-gcp-identity.test.sh` (delete the now-dead
  `# DOC-CHECKS-ANCHOR (Task 3 appends here)` line only)

**Interfaces:**
- Consumes: provisioning content from the gcloud-robot skill's
  `references/provisioning.md` (role choice, scoped-grant command shapes,
  rotation/revocation/monitoring contracts) and the corrected role set from
  Global Constraints (verified during review remediation).
- Produces: the runbook the wrappers' `--help` text and AGENTS.md point at.

- [ ] **Step 1: Author the docs**

**1a.** Create `docs/development/gcloud-robot.md` with exactly this content:

````markdown
# gcloud-robot identity for cloud test lanes

Freshell's cloud test lanes (`scripts/e2e-cloud.sh`, `scripts/vitest-cloud.sh`
— Cloud Run Jobs for Playwright e2e and Vitest suites, plus their shared
Cloud Build / Artifact Registry image machinery) no longer depend on an
interactive `gcloud auth login`. Interactive gcloud sessions ride OAuth
refresh tokens that Google silently culls (roughly hourly under heavy agent
use); the last observed casualty was a base-gate run dying mid-lane with
`Reauthentication failed. cannot prompt during non-interactive execution`
(2026-08-23, UTC). The replacement is the gcloud-robot pattern: one
per-project robot service account minted from a local JSON key — no browser
login, no refresh token, no hourly expiry.

Project: `misc-puttering-project` (region `us-west1`, AR repo `freshell-e2e`).
Robot: `gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`.

## Security, stated plainly

A JSON key is bearer power with no MFA and — by default — no expiry. It is
weaker than an expiring interactive session. Two things bound the risk:
least-privilege per-project grants (below), and rotation plus instant
revocation as first-class operations (below). The control that still holds
when logs are blind is the standing rotation cadence — keep one, and enable
the key-usage alerting in "Monitor".

## Adoption states

The repo is in exactly one of two states at any time:

1. **wired but not yet provisioned** — the ladder and this runbook are
   committed, but the robot SA/key do not exist yet. Expected behavior: lanes
   run exactly as before under ambient gcloud, with one quiet stderr note
   (`gcloud-robot: no probed identity; using ambient gcloud` / `skill not
   found ... — using ambient gcloud`). In this state `verify-as-robot.sh`
   failing at the key/token-mint rung is the CORRECT result, not a
   regression — do not debug it, provision.
2. **provisioned and verified** — provisioning below completed and the
   verification ladder passed as the robot.

## How lanes resolve identity (after conversion)

Lazily, immediately before a cloud lane's first real gcloud call (`help` and
`run --local` never resolve anything and need zero GCP tooling), in this
fixed order:

1. `--account=<email>` flag — call-site pin, always wins.
2. `FRESHELL_GCP_ACCOUNT` env — repo pin, also always wins.
3. `GCLOUD_IDENT` env — explicit bypass (CI, hermetic tests): used verbatim,
   no probe, no network.
4. gcloud-robot probe — `$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh`
   picks the first credentialed account passing the lane's live
   `testIamPermissions` probe. The robot "just works" wherever its key is
   activated; human accounts keep working untouched.
5. Ambient gcloud (default when nothing above resolves), announced once on
   stderr. Set `GCLOUD_ROBOT_REQUIRE=1` to fail closed with guidance instead
   (hardening / CI).

A resolved identity pins every `--account` the wrappers emit and exports
`CLOUDSDK_CORE_ACCOUNT`/`CLOUDSDK_CORE_PROJECT` for any unpinned descendants.

## Operator setup

### Prerequisites

- The `gcloud-robot` skill installed for your agent platform (whatever
  directory holds its `scripts/` — the repo never records that path).
- The Cloud Resource Manager API enabled on the project (the identity probe's
  `testIamPermissions` call needs it; any project that has ever touched IAM
  already has it — `gcloud services enable cloudresourcemanager.googleapis.com
  --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"`
  is the one-time, idempotent enable).
- Point the lanes at it once, e.g. in `~/.bashrc`:

  ```bash
  export GCLOUD_ROBOT_HOME="<installed gcloud-robot skill directory>"
  # Prefer the robot when several accounts pass the probe:
  export GCLOUD_ROBOT_ACCOUNT="gcloud-robot@misc-puttering-project.iam.gserviceaccount.com"
  ```

### Provision (once per project, human-run — agents never run these)

All commands pin `--account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"` to your operator
account (export it). All skill scripts are invoked via
`bash "$GCLOUD_ROBOT_HOME/scripts/<name>.sh"`.

1. Bootstrap the robot (project-level roles):

   ```bash
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_ROLES="cloudbuild.builds.editor artifactregistry.writer run.developer logging.viewer" \
   GCLOUD_ROBOT_ADMIN_ACCOUNT="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
   bash "$GCLOUD_ROBOT_HOME/scripts/bootstrap-robot.sh" --name gcloud-robot --activate
   ```

   This creates the SA, binds the project roles, mints a JSON key under
   `~/.local/share/gcloud-robot/` (mode 600, never inside
   `~/.config/gcloud`), prints the key path, and activates it. Record the
   key location for yourself as
   `key-path: <printed at provisioning>` (until then this runbook says:
   not yet minted — operator step).

   Also ensure the Artifact Registry repository exists. The robot holds
   `artifactregistry.writer` (push) but writer CANNOT create repositories,
   and the wrappers' create-if-missing path is `|| true`-masked — a missing
   repo would surface only as a push failure mid-run:

   ```bash
   gcloud artifacts repositories describe freshell-e2e \
     --location=us-west1 --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" || \
   gcloud artifacts repositories create freshell-e2e \
     --repository-format=docker --location=us-west1 --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
   ```

2. Scoped grants (bootstrap does NOT do these; skipping them is the classic
   "probe passes, build 403s" failure):

   ```bash
   # Staging bucket Cloud Build uploads source to (confirm the name; the
   # default is <project>_cloudbuild):
   BUCKET="$(gcloud storage buckets list --project=misc-puttering-project \
       --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --format='value(name)' | grep cloudbuild)"
   for role in roles/storage.objectAdmin roles/storage.legacyBucketReader; do
     gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
       --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
       --role="$role" \
       --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
   done

   # actAs on the default build/run identities. Cloud Run jobs execute as the
   # project default compute SA, so creating jobs requires actAs on it. Cloud
   # Build's default execution identity is DISCOVERED, not assumed: on older
   # projects it is the legacy <number>@cloudbuild.gserviceaccount.com
   # (Google-owned, accepts NO bindings — skip it), on newer ones the compute
   # default SA. (actAs beyond this is only needed when a build config pins
   # serviceAccount: — docker/cloud-run/cloudbuild.yaml pins none.)
   PROJECT_NUMBER=$(gcloud projects describe misc-puttering-project \
     --format='value(projectNumber)' --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT")
   BUILD_SA="$(gcloud builds get-default-service-account --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" | grep -oE '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+' | head -1)"
   for sa in "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" ${BUILD_SA:+"$BUILD_SA"}; do
     case "$sa" in
       *@cloudbuild.gserviceaccount.com) echo "skipping $sa (legacy Cloud Build SA accepts no IAM bindings)"; continue ;;
     esac
     gcloud iam service-accounts add-iam-policy-binding "$sa" \
       --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
       --role=roles/iam.serviceAccountUser \
       --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
   done
   ```

3. Verify as the robot. Read-only probes retry through IAM propagation lag;
   a failure that persists past the retries names the missing grant.

   ```bash
   # For a quick pre-flight use GCLOUD_ROBOT_RETRIES=2 GCLOUD_ROBOT_RETRY_SLEEP=2,
   # then unset them for the real run.
   GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_PROBE_PERMISSION=cloudbuild.builds.create \
   GCLOUD_ROBOT_KEY_FILE=<key path printed by bootstrap> \
   bash "$GCLOUD_ROBOT_HOME/scripts/verify-as-robot.sh" \
     --probe "gcloud artifacts repositories describe freshell-e2e --location=us-west1 --project=misc-puttering-project" \
     --probe "gcloud artifacts docker images describe us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:latest --project=misc-puttering-project" \
     --probe "gcloud run jobs list --region=us-west1 --project=misc-puttering-project --limit=1" \
     --probe "gcloud builds list --project=misc-puttering-project --limit=1"
   ```

   The wrappers read execution logs via `gcloud beta run jobs executions logs
   read ... || true`, which masks a missing `roles/logging.viewer` quietly.
   When an execution exists, list a real log read as an explicit probe too:
   `--probe "gcloud beta run jobs executions logs read <execution-name> --project=misc-puttering-project --region=us-west1"`.

   Read probes alone do NOT prove the lane: they skip the scoped bucket
   grants, job create/delete, actAs, and the per-execution overrides the
   vitest lane uses. Finish verification with ONE REAL LANE SMOKE as the
   robot (~$0.02; small test file):

   ```bash
   GCLOUD_IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     bash scripts/vitest-cloud.sh run --cloud --config=default --shards=1 \
       test/unit/lib/pane-utils.test.ts
   ```

   Expected on success: `All tasks completed successfully.` A 403 names the
   missing grant in its error message — add the smallest covering grant
   (`bootstrap-robot.sh --no-key` updates roles without touching keys), then
   re-verify and re-smoke. Only after the probes AND the smoke pass is the
   repo "provisioned and verified".

4. Done. `npm run test:cloud` / `npm run test:e2e:cloud` now select the robot
   automatically wherever its key is activated; no `.env` or repo config
   exists for this (`.env.example` is server-runtime config and deliberately
   carries no cloud-lane knobs).

### Rotate (standing cadence — suggest quarterly, and after any suspicion)

1. Mint + activate a new key. Re-supply the CURRENT role list exactly —
   `bootstrap-robot.sh` re-applies it verbatim and bindings are additive-only:

   ```bash
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_ROLES="cloudbuild.builds.editor artifactregistry.writer run.developer logging.viewer" \
   GCLOUD_ROBOT_ADMIN_ACCOUNT="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
   bash "$GCLOUD_ROBOT_HOME/scripts/bootstrap-robot.sh" --rekey --activate
   ```

2. Prove the real lane works as the robot (verify block above with the new
   key path).
3. Delete the OLD key id in IAM (list with `--managed-by=user`, pick the row
   whose id matches the old key file's `private_key_id`):

   ```bash
   gcloud iam service-accounts keys list --managed-by=user \
     --iam-account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
   gcloud iam service-accounts keys delete <OLD_KEY_ID> \
     --iam-account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
   ```

4. On any other host holding the old key copy, delete the file and run
   `gcloud auth revoke gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`
   there (never on the host that just activated the new key).

### Revoke (leak response)

Delete the key in IAM (`keys delete`, above) — that instantly stops all NEW
token minting from every copy of the key. Tokens already minted stay valid
for up to an hour (Google-documented; key deletion does not invalidate issued
credentials). For an immediate total cutoff:

```bash
gcloud iam service-accounts disable gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
```

(Disabling halts all use project-wide until re-enabled — that is the trade
for immediacy.)

### Monitor (safety net, with honest limits)

- Key lifecycle events: `CreateServiceAccountKey` is a default-on Admin
  Activity audit event. Create a log-based metric (fully-qualified method
  name, scoped to the robot) and alert on it in your monitoring stack:

  ```bash
  gcloud logging metrics create robot-key-creations \
    --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
    --description="key creation events for the gcloud-robot SA" \
    --log-filter='protoPayload.methodName="google.iam.admin.v1.CreateServiceAccountKey" AND resource.labels.email_id="gcloud-robot@misc-puttering-project.iam.gserviceaccount.com"'
  ```

- Key usage: `iam.googleapis.com/service_account/key/authn_events_count`
  (per-`key_id`) is the best available signal — but it is sampled every 600s
  and data lags up to ~3 hours, so it suits anomaly review and off-hours
  alerting, not instant paging. Rotation remains the control that holds when
  logs are blind.

### Troubleshooting

- Probe passes but `gcloud builds submit` 403s → the actAs grants (step 2).
- Cloud Build dies resolving source/logs (`storage.buckets.get` 403) → the
  bucket-scoped `roles/storage.legacyBucketReader` (step 2); object roles
  alone never carry bucket metadata reads.
- Push 403s or the run logs "Creating Artifact Registry repository" then
  fails → step 1's repo-exists check was skipped: writer cannot create
  repositories. Run the describe/create block from provisioning.
- A grant that definitely exists 403s for the first minutes → IAM
  propagation lag; the verifier's retries (12 × 30s default) absorb it.
- A lane prints the ambient-fallback note and then gcloud's
  "Reauthentication failed" → the lane fell back to ambient gcloud: the
  robot is not provisioned (or not activated) on this machine. Provision
  (above) or re-login interactively; both work, the point is the robot
  cannot be culled.

### CI

No GitHub Actions workflow touches GCP (verified by survey); keep it that
way. If CI ever needs GCP, use Workload Identity Federation (keyless) —
never a JSON key in CI.
````

**1b.** Edit `AGENTS.md` — append this paragraph at the end of the
`### Vitest Test Backend (Cloud Run Jobs)` section (immediately after the
"**Note:** The electron suite always runs locally even in cloud mode ..."
paragraph, before the `### E2E Test Backend (Cloud Run Jobs)` heading):

```markdown
**Identity:** cloud lanes never require an interactive `gcloud auth login`.
They resolve a gcloud identity lazily, in this order: `--account=` flag >
`FRESHELL_GCP_ACCOUNT` > `GCLOUD_IDENT` > gcloud-robot probe (needs
`GCLOUD_ROBOT_HOME`, the installed gcloud-robot skill directory) > ambient
gcloud (with a one-line stderr note). Provisioning, rotation, and revocation
live in [docs/development/gcloud-robot.md](docs/development/gcloud-robot.md).
`GCLOUD_ROBOT_REQUIRE=1` fails closed when no robot identity resolves.
```

**1c.** Edit `AGENTS.md` — append this paragraph at the end of the
`### E2E Test Backend (Cloud Run Jobs)` section (immediately after the
"**Before filing any PR, ensure the affected e2e specs actually pass on the
configured `FRESHELL_E2E_BACKEND` backend** ..." paragraph, before the
`## Architecture` heading): the identical Identity paragraph from 1b
(verbatim — both sections name the same contract).

**1d.** Delete the `# DOC-CHECKS-ANCHOR (Task 3 appends here)` line from
`scripts/test/cloud-gcp-identity.test.sh` (the doc checks were cut per the
repo's test-quality bar; the anchor is dead).

- [ ] **Step 2: Verify**

2a. Read-through of the rendered runbook for command accuracy against the
skill references (provisioning.md shapes: scoped grants carry
`--condition=None`, skill scripts invoked as `bash
"$GCLOUD_ROBOT_HOME/scripts/<name>.sh"`, key outside `~/.config/gcloud`) and
confirm the AGENTS.md links resolve to the new file's path.

2b. Regression sweep — AGENTS.md ships inside the cloud image and the identity
suite lost only a comment line, so the impacted set is the full cloud-suite
loop:

Run:
```bash
for t in scripts/test/cloud-gcp-identity.test.sh \
         scripts/test/cloud-build.test.sh \
         scripts/test/cloud-exec-id-parse.test.sh \
         scripts/test/cloud-vitest-wrapper.test.sh \
         scripts/test/cloud-run-wrapper.test.sh; do
  bash "$t" || { echo "SUITE FAILED: $t"; exit 1; }
done
```

Expected: PASS — every suite exits 0.

- [ ] **Step 3: Commit the task**

```bash
git add docs/development/gcloud-robot.md AGENTS.md scripts/test/cloud-gcp-identity.test.sh
git commit -m "docs(cloud): add gcloud-robot operator runbook + AGENTS.md identity sections"
```

---

## Verification matrix (behavior → where proven)

| Behavior | Proof |
| --- | --- |
| Ladder rung 2 (GCLOUD_IDENT) bypasses probe, pins + exports identity | Task 1 check B; Task 2 W1/W6a on the real wrappers |
| Ladder rung 3 probe selects robot; project+probe env forwarded to selector | Task 1 checks C and I; Task 2 W4 on the real wrapper (single selector run) |
| Ladder rung 4 ambient fallback: exactly one stderr note, exit 0, no crash | Task 1 checks D/E; Task 2 W5/W6b on the real wrappers |
| `GCLOUD_ROBOT_REQUIRE=1` fails closed with guidance (both failure shapes) | Task 1 checks F/G |
| Idempotency (one probe per process, even across lanes) | Task 1 check H |
| Rung-1 pins (`--account=`, `FRESHELL_GCP_ACCOUNT`) always win | Task 1 check J; Task 2 W2/W3 on the real wrapper |
| No hardcoded human account anywhere in wrappers or help | Task 2 W1 grep; W10/W11 absence checks |
| `--account` omitted (not empty-flagged) when nothing resolves | Task 2 W5/W6b (absent accounts log) |
| help/local lanes need zero GCP tooling and stay silent | Task 2 W8/W9; pre-existing cloud-run-wrapper check 12 |
| Trap-11: stubbed suites never reach the probe | Task 2 W7 (four nested suites under a hostile marker-trap home) |
| Hardcoded-default removal documented in help | Task 2 W10/W11 |
| Runbook + AGENTS.md docs | Task 3 — docs-only task; repo TDD doc exemption applies; verified by read-through + suite regression sweep |
| Provisioning/rotation/revocation correctness | Documented only — human-executed; skill-mandated exclusion (no agent runs GCP mutations); surface completeness hardened by verify probes + one real lane smoke |
| Whole-repo regression | Workflow stage gate (coordinated suite), outside task scope |

## Risk notes

- **Mirrored wrappers.** The two wrappers keep their established parallel
  layout; the only shared code is the helper. A reviewer comparing the two
  diffs should see identical structural edits with vitest/e2e name swaps and
  the defaults that already differ (shards, timeout, job prefix).
- **One-process-one-probe.** A `run --cloud` that falls through to
  `cmd_build` resolves on the run probe (`run.jobs.run`) first and never
  re-probes for the build leg — correct by design (robot holds the union of
  roles); a misconfigured identity fails fast on the real gcloud error, which
  the ambient note contextualizes.
- **Ambient fallback keeps old behavior.** Lanes on skill-less machines print
  one note and run exactly as before (including, today, the culled-credential
  failure mode). That is the contract: adoption is non-breaking; provisioning
  is the fix.

