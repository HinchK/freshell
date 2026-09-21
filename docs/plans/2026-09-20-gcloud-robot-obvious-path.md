# gcloud-robot obvious-path Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix KataTracker item e83z "Cloud lanes: make the gcloud-robot identity the obviously correct path": agent-launched Freshell cloud test lanes (scripts/vitest-cloud.sh and scripts/e2e-cloud.sh, both consuming scripts/lib/gcp-identity.sh) resolve the provisioned gcloud-robot identity by default instead of silently falling through to a possibly-stale ambient identity; non-interactive shells fail fast on identity errors instead of hanging on interactive reauth prompts; lane startup observably reports the resolved identity, the ladder rung that produced it, and loud dirty-tree state when the -dirty image path is taken; AGENTS.md documents GCLOUD_ROBOT_REQUIRE=1 as the recommended default for agent-launched broad gates.

### Explicit constraints
- scripts/lib/gcp-identity.sh: when GCLOUD_ROBOT_HOME is unset, probe well-known robot install locations (~/.codex/skills/gcloud-robot, ~/.claude/skills/gcloud-robot, ~/code/skill-gcloud-robot/gcloud-robot) before falling to ambient gcloud; the probe must validate a real executable skill installation (select-gcloud-identity.sh present and executable); on no match, fall through with the existing one-line note; no behavior change for submitters without robot accounts.
- scripts/vitest-cloud.sh and scripts/e2e-cloud.sh: export CLOUDSDK_CORE_DISABLE_PROMPTS=1 only when stdin is not a TTY ([ ! -t 0 ]), so agents get fail-fast errors instead of silent 90-minute hangs while humans in a terminal keep interactive reauth; add a cheap `gcloud auth print-access-token` preflight at lane start so identity failures surface in seconds, before any build/submit work.
- Observability: the lane startup banner prints the resolved identity and which ladder rung produced it; when a robot install exists at a known path but was not selected, say so explicitly; surface dirty-tree state loudly when the -dirty image path is taken.
- Docs: AGENTS.md test-coordination section documents GCLOUD_ROBOT_REQUIRE=1 as the recommended default for agent-launched broad gates (fail closed instead of silently falling to a possibly-stale human identity).
- Tests: extend the stubbed-ladder suites (scripts/test/cloud-gcp-identity.test.sh, scripts/test/cloud-vitest-wrapper.test.sh, scripts/test/cloud-build.test.sh) with well-known-path discovery cases, TTY-gated disable-prompts assertions, and preflight coverage.
- Landing: separate tiny worktree + PR, not part of the terminal-restore run branch.
- Run under the-usual workflow (isolated worktree, red/green/refactor TDD, independent reviews).

### Accepted tradeoffs and residuals
- The incident's related hardening — the -dirty image build path itself and the Cloud Run log-fetch fallback ("WARNING: could not capture execution ID") — merits scrutiny but is outside this fix; only the loud dirty-tree surfacing required by the observability constraint is in scope.
- Humans in a terminal keep interactive reauth (prompts are disabled only for non-TTY stdin).
- Submitters without robot accounts see no behavior change (probe falls through with the existing one-line note).

**Goal:** Agent-launched cloud test lanes find a standard gcloud-robot install automatically, fail fast on dead credentials instead of hanging on a reauth prompt, and observably report which identity they run as and when a dirty tree forces a non-reusable image build.

**Architecture:** All identity logic stays in `scripts/lib/gcp-identity.sh`: the gcloud-robot skill's `resolve_gcp_identity` drop-in block is left byte-identical, and well-known-path discovery plus rung attribution are added to the Freshell-owned bridge `freshell_resolve_cloud_identity`, which defaults `GCLOUD_ROBOT_HOME` before the untouched ladder runs. The two lane wrappers (`scripts/vitest-cloud.sh`, `scripts/e2e-cloud.sh` — manually mirrored files; every edit applies to both) gain a TTY-gated `CLOUDSDK_CORE_DISABLE_PROMPTS=1` export at the top, a cheap `gcloud auth print-access-token` preflight immediately after each identity resolve (four call sites per wrapper, all through `account_flag`), an identity+source line in the run-lane startup banner (stdout, so the identity suite's exact one-stderr-line assertions keep holding), and a loud stdout WARNING banner line whenever the `-dirty` image path is taken. Tests live only in the three named bash suites, which run directly (`bash scripts/test/<name>.test.sh`) — no runner wiring exists to update.

**Tech Stack:** Bash (`set -euo pipefail` discipline), the existing hermetic bash test harnesses (`check`/`run_ladder`/fake `gcloud`/fake selector), `script -qec` (util-linux 2.39.3, verified present) for the TTY-side assertions, plain docs (AGENTS.md, docs/development/gcloud-robot.md, wrapper `usage()` text).

## Global Constraints

- Both wrappers are manually mirrored: every production edit applies to `scripts/vitest-cloud.sh` and `scripts/e2e-cloud.sh` identically modulo the `[vitest-cloud]`/`[e2e-cloud]` prefix (mirrored-comment discipline per existing precedent).
- The skill drop-in block in `gcp-identity.sh` (lines 27–51, `resolve_gcp_identity`) must NOT be hand-edited; the header comment (lines 10–15) that says discovery happens "only via `GCLOUD_ROBOT_HOME`" must be rewritten to describe bridge-owned well-known-path discovery instead. The divergence from the skill's SKILL.md ("the ONLY sanctioned resolution is `GCLOUD_ROBOT_HOME`") is sanctioned by the kata (the skill's own override rule).
- The existing no-match ambient note (`gcp-identity.sh` line 45: `gcloud-robot: skill not found at ${GCLOUD_ROBOT_HOME:-<unset>} — using ambient gcloud (set GCLOUD_ROBOT_HOME to get robot identity)`, with an em-dash) must stay byte-identical: checks E/W5/W6b grep `skill not found .* using ambient gcloud` and require exactly one stderr line. All new banner/warning output goes to stdout.
- Every non-`info` gcloud call in pinned wrapper runs must carry `--account` (`accounts_all_equal` invariant, cloud-gcp-identity.test.sh:277–285): the preflight goes through `$(account_flag)`.
- Test hermeticity: the suites never touch the network and never execute the real `~/.codex/skills/gcloud-robot` selector. Two real installs exist on this machine (~/.codex/skills/gcloud-robot and ~/code/skill-gcloud-robot/gcloud-robot), and all three candidate paths are `$HOME`-relative — every ladder/wrapper invocation in `cloud-gcp-identity.test.sh` that can reach the probe must run with a controlled `HOME`. `env` assignment order is verified: a later `HOME=...` in the forwarded args overrides an earlier default (checked live).
- The bridge's existing external contract is preserved exactly: rung-1 pin short-circuit first for any FRESH call (a pinned call with no `$1` must still succeed — `$1` is dereferenced only at the `GCLOUD_ROBOT_PROBE_PERMISSION` export), `GCP_ACCOUNT="${GCLOUD_IDENT:-}"` adoption, and `return 1` propagation under `GCLOUD_ROBOT_REQUIRE=1`. Repeat calls in the same process keep the first resolve's attribution (the ladder's own `GCLOUD_IDENT_RESOLVED` guard; a pin that appears after a first resolve is an adoption, not a pin — check K9 pins this).
- Both wrappers run `set -euo pipefail`: the TTY test must use the `if [ ! -t 0 ]; then ...; fi` form (a bare `[ ! -t 0 ] && export` would exit the script when stdin IS a tty).
- No behavior change for submitters without robot accounts: with no `GCLOUD_ROBOT_HOME` and no well-known install, every path is byte-identical to today.
- Bash suites are invoked directly (`bash scripts/test/<name>.test.sh`) — no package.json/coordinator/CI wiring exists for them and none may be added.
- No TypeScript/Rust/client changes: the pre-push gate's typecheck/clippy lanes see no matching files.
- Work only in `.worktrees/gcloud-robot-obvious-path` on branch `the-usual/gcloud-robot-obvious-path`; never touch the main checkout's tracked files.
- Out of scope (do NOT fix incidentally): the `-dirty` rebuild path itself, the "WARNING: could not capture execution ID" log-fetch fallback (vitest:535 / e2e:635), vitest's `gcloud info` `|| true` divergence (vitest:92 lacks the guard e2e:97 has), the selector's human-first candidate order, the stale `~/.bashrc` comment, and the skill's own repo at `~/code/skill-gcloud-robot` (flag the divergence in the PR description instead).

---

### Task 1: Well-known-path discovery + rung attribution in the identity library, with a hermetic HOME retrofit of the ladder suite

**Files:**
- Modify: `scripts/lib/gcp-identity.sh` (header comment lines 10–15; add `freshell_discover_robot_home()`; extend bridge `freshell_resolve_cloud_identity` lines 68–86)
- Modify: `scripts/test/cloud-gcp-identity.test.sh` (harness: `run_ladder` gains a default `HOME` + `source=` transcript line; every W-series wrapper invocation except W9 gains an explicit `HOME`; new checks K1–K8, W7b)

**Interfaces:**
- Consumes: existing `resolve_gcp_identity` (untouched); `run_ladder` transcript keys `rc=`/`ident=`/`account=`/`pin=` (the new `source=` key is added by this task).
- Produces:
  - `freshell_discover_robot_home()` — echoes the first well-known install whose `scripts/select-gcloud-identity.sh` is a present, executable regular file; rc 1 when none.
  - Bridge behavior: when `GCLOUD_IDENT` and `GCLOUD_ROBOT_HOME` are both empty, the bridge calls discovery and exports `GCLOUD_ROBOT_HOME` on a hit before calling the untouched ladder; sets plain shell var `FRESHELL_GCP_IDENTITY_SOURCE` at every outcome: `pin (--account flag or FRESHELL_GCP_ACCOUNT)` | `GCLOUD_IDENT (explicit env bypass)` | `gcloud-robot probe (GCLOUD_ROBOT_HOME: <path>)` | `gcloud-robot probe (well-known install: <path>)` | `ambient gcloud (probe produced no identity)` | `ambient gcloud (well-known install produced no identity: <path>)` | `ambient gcloud (no robot skill found)`.
  - New one-line stderr note (only when discovery found an install and no identity resulted, default or strict mode): `gcloud-robot: well-known install at <path> produced no identity`.
  - `run_ladder` transcripts gain `source=`.

- [ ] **Step 1: Write the failing behavioral tests**

In `scripts/test/cloud-gcp-identity.test.sh`:

**Pre-step 0 — repair the pre-existing red in `cloud-exec-id-parse.test.sh` (harness drift, its own commit, BEFORE the red run):** the e2e wrapper's unconditional structured-receipts reconciliation (introduced by commits c09e1fa67/e1b23bc37, after this suite's fake was last touched) calls `gcloud logging read`, which the suite's fake gcloud never stubs — `e2e-cloud-structured-receipts.mjs` then throws on empty input and three e2e-side checks ("exits 0 on green run", "reports truthfully (succeeded=1)", "describe targets clean execution id") are red at the base commit on any machine (verified directly in this worktree, 2026-09-21), and the identity suite's W7 nested leg inherits the failure. Add the missing stub branch to that suite's fake gcloud (shape mirrors its existing branches; the payload matches what `e2e-cloud-structured-receipts.mjs` parses):

```bash
  if [[ "$*" == *"logging read"* ]]; then
    printf '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"test-exec-123","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}]\n'
    exit 0
  fi
```

Verify: `bash scripts/test/cloud-exec-id-parse.test.sh` goes from 3 failed checks to all-PASS (the first cold cargo/playwright warm-up in a fresh worktree is slow — W7's nested `cloud-run-wrapper.test.sh` does a real release cargo build; expect one slow first run, fast after). Commit separately: `test: repair cloud-exec-id-parse fake gcloud logging read stub (pre-existing red, harness drift)`. This is a test-harness repair, not a behavior change and not test-weakening: it restores the suite's intended green shape against the wrapper's existing receipts contract.

**Harness retrofit** (test scaffolding; it must keep every existing check green — verified in Step 2):

1. After the `FAKE_HOME` selector setup (after line 53), add the controlled-home fixtures:

```bash
# Controlled $HOME fixtures for well-known-path discovery (kata e83z): the
# candidates are all $HOME-relative, and this machine has REAL installs, so
# every probe-capable invocation must control HOME.
EMPTY_HOME="$TDIR/home-empty"
mkdir -p "$EMPTY_HOME"

# mk_robot_install <home> <relpath> <account> — a fixed-account fake install
# (deliberately marker-free: adoption is proven by the returned ident).
mk_robot_install() {
  local home="$1" rel="$2" acct="$3"
  mkdir -p "$home/$rel/scripts"
  printf '#!/usr/bin/env bash\necho %s\n' "$acct" > "$home/$rel/scripts/select-gcloud-identity.sh"
  chmod +x "$home/$rel/scripts/select-gcloud-identity.sh"
}

# mk_marker_robot_install <home> <relpath> — an install whose selector is a
# copy of the inert FAKE_HOME selector (marker + SELECTOR_FAIL semantics).
mk_marker_robot_install() {
  local home="$1" rel="$2"
  mkdir -p "$home/$rel/scripts"
  cp "$FAKE_HOME/scripts/select-gcloud-identity.sh" "$home/$rel/scripts/select-gcloud-identity.sh"
  chmod +x "$home/$rel/scripts/select-gcloud-identity.sh"
}
```

2. In `run_ladder` (lines 80–95): add the default `HOME` into the `env` prefix BEFORE the forwarded `"$@"` (later `env` assignments win — verified), and add the `source=` transcript line inside the inner `bash -c`. Extend the `SCRUB` list with the three new bridge variables so a host environment can never skew a check (the suite's own SCRUB philosophy; load-bearing for the bridge's new early-return and attribution paths):

```bash
SCRUB=(-u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE
       -u GCLOUD_ROBOT_PROJECT -u GCLOUD_ROBOT_PROBE_PERMISSION
       -u FRESHELL_GCP_ACCOUNT -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT
       -u SELECTOR_ACCOUNT -u SELECTOR_FAIL
       -u GCLOUD_IDENT_RESOLVED -u FRESHELL_GCP_IDENTITY_SOURCE
       -u FRESHELL_ROBOT_HOME_DISCOVERED
       -u GCLOUD_ROBOT_ACCOUNT -u CLOUDSDK_CORE_DISABLE_PROMPTS)
```

(`GCLOUD_ROBOT_ACCOUNT` joins the scrub list for host-leak hygiene AND because new checks deliberately set it as the robot-first guarantee lever; `CLOUDSDK_CORE_DISABLE_PROMPTS` must be scrubbed so the TTY-side assertions cannot be skewed by a host that already exports it — otherwise a host export makes correct TTY behavior look broken and lets the non-TTY red pass vacuously. Also extend the FAKE_SELECTOR body in the suite: record `account=${GCLOUD_ROBOT_ACCOUNT:-}` alongside the existing `project=`/`probe=` env-contract line, and echo `"${GCLOUD_ROBOT_ACCOUNT:-${SELECTOR_ACCOUNT:-}}"` as its result — existing checks pass GCLOUD_ROBOT_ACCOUNT unset, so their behavior is unchanged.)

```bash
run_ladder() {
  local probe="$1"
  shift
  rm -f "$LADDER_STDERR" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  env "${SCRUB[@]}" HOME="$EMPTY_HOME" "$@" bash -c '
    set -u
    . "$1"
    GCP_PROJECT="misc-puttering-project"
    GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
    if freshell_resolve_cloud_identity "$2"; then rc=0; else rc=$?; fi
    printf "rc=%s\n" "$rc"
    printf "ident=%s\n" "${GCLOUD_IDENT:-}"
    printf "account=%s\n" "${CLOUDSDK_CORE_ACCOUNT:-}"
    printf "pin=%s\n" "$GCP_ACCOUNT"
    printf "source=%s\n" "${FRESHELL_GCP_IDENTITY_SOURCE:-}"
  ' _ "$HELPER" "$probe" 2>"$LADDER_STDERR" || true
}
```

3. Add `HOME="$EMPTY_HOME"` to every W-series wrapper invocation AND the W9 invocation (uniform). The earlier draft's W9 carve-out was falsified live: `npx vitest` resolves from repo-local `node_modules` and needs nothing from the real `HOME` (cloud-vitest-wrapper's real local legs are green under a hostile empty `HOME` — live-proven 2026-09-21), so W9 joins the uniform retrofit (it still requires the repo's `node_modules` to be installed — `npm ci` in the worktree, standard). Post-change, W5/W6b/W8/W9 and every invocation that leaves `GCLOUD_IDENT`/`GCLOUD_ROBOT_HOME`/pins unset NEED the controlled `HOME`; the pinned/probed ones get it for uniformity.

**New checks** (append after check J, following the suite's real idiom — invocations at suite level, `check` greps via positional args):

```bash
# --- Check K: well-known-path discovery (kata e83z) -------------------------
# K1: unset GCLOUD_ROBOT_HOME + a valid install at the .codex well-known path.
WK1_HOME="$TDIR/home-k1"; mkdir -p "$WK1_HOME"
mk_robot_install "$WK1_HOME" ".codex/skills/gcloud-robot" "discovered-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK1_HOME")
check "K1 well-known .codex install is discovered and probed" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "discovered-robot@example.invalid" ] &&
    [ "$3" = "discovered-robot@example.invalid" ] &&
    case "$4" in *"well-known install: "*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" pin)" "$(field "$OUT" source)"

# K2: probe order — .codex wins when all three exist.
WK2_HOME="$TDIR/home-k2"; mkdir -p "$WK2_HOME"
mk_robot_install "$WK2_HOME" ".claude/skills/gcloud-robot" "claude-robot@example.invalid"
mk_robot_install "$WK2_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-robot@example.invalid"
mk_robot_install "$WK2_HOME" ".codex/skills/gcloud-robot" "codex-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2_HOME")
check "K2 first well-known match (.codex) wins over .claude and ~/code" \
  bash -c '[ "$1" = "codex-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K2b: .claude is second when .codex is absent.
WK2B_HOME="$TDIR/home-k2b"; mkdir -p "$WK2B_HOME"
mk_robot_install "$WK2B_HOME" ".claude/skills/gcloud-robot" "claude-robot@example.invalid"
mk_robot_install "$WK2B_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2B_HOME")
check "K2b .claude wins when .codex absent" \
  bash -c '[ "$1" = "claude-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K2c: the ~/code checkout alone is a valid third candidate (guards against
# the candidate list silently losing or misspelling its last entry).
WK2C_HOME="$TDIR/home-k2c"; mkdir -p "$WK2C_HOME"
mk_robot_install "$WK2C_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-only-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2C_HOME")
check "K2c sole ~/code/skill-gcloud-robot install is discovered" \
  bash -c '[ "$1" = "code-only-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K3: install present but selector NOT executable -> not a real install; the
# existing one-line no-match note must stay byte-identical and alone on stderr.
WK3_HOME="$TDIR/home-k3"
mkdir -p "$WK3_HOME/.codex/skills/gcloud-robot/scripts"
printf '#!/usr/bin/env bash\necho not-exec-robot@example.invalid\n' \
  > "$WK3_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
chmod -x "$WK3_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
OUT=$(run_ladder "run.jobs.run" HOME="$WK3_HOME")
check "K3 non-executable selector rejected; ambient note byte-identical, one stderr line, selector never ran" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] &&
    [ "$(wc -l < "$3")" = "1" ] &&
    grep -qx "gcloud-robot: skill not found at <unset> — using ambient gcloud (set GCLOUD_ROBOT_HOME to get robot identity)" "$3" &&
    [ ! -e "$4" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR" "$SELECTOR_MARKER"

# K4: select-gcloud-identity.sh being a DIRECTORY is not a real executable skill.
WK4_HOME="$TDIR/home-k4"
mkdir -p "$WK4_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
OUT=$(run_ladder "run.jobs.run" HOME="$WK4_HOME")
check "K4 directory at the selector path is rejected (one ambient note only)" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] && [ "$(wc -l < "$3")" = "1" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR"

# K5: discovered install whose probe fails -> the explicit not-selected note
# accompanies the ladder's own probe-empty note; ambient still permitted (rc 0).
WK5_HOME="$TDIR/home-k5"; mkdir -p "$WK5_HOME"
mk_marker_robot_install "$WK5_HOME" ".codex/skills/gcloud-robot"
OUT=$(run_ladder "run.jobs.run" HOME="$WK5_HOME" SELECTOR_FAIL=1)
check "K5 install exists but probe empty -> explicit not-selected note + ladder note, 2 stderr lines, rc 0" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] &&
    [ "$(wc -l < "$3")" = "2" ] &&
    grep -q "no probed identity; using ambient gcloud" "$3" &&
    grep -q "^gcloud-robot: well-known install at .*/\.codex/skills/gcloud-robot produced no identity$" "$3" &&
    case "$4" in *"well-known install produced no identity"*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR" "$(field "$OUT" source)"

# K6: discovery + strict mode fails closed, still saying the install existed.
OUT=$(run_ladder "run.jobs.run" HOME="$WK5_HOME" SELECTOR_FAIL=1 GCLOUD_ROBOT_REQUIRE=1)
check "K6 strict mode with discovered-but-failing install fails closed, not-selected note present" \
  bash -c '
    [ "$1" != "0" ] &&
    grep -q "no identity passes the probe" "$2" &&
    grep -q "well-known install at .* produced no identity" "$2"
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR"

# K7: an explicit GCLOUD_ROBOT_HOME suppresses discovery even with installs present.
OUT=$(run_ladder "run.jobs.run" HOME="$WK2_HOME" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      SELECTOR_ACCOUNT="explicit-home-robot@example.invalid")
check "K7 explicit GCLOUD_ROBOT_HOME wins over well-known paths (source names GCLOUD_ROBOT_HOME)" \
  bash -c '
    [ "$1" = "explicit-home-robot@example.invalid" ] &&
    case "$2" in "gcloud-robot probe (GCLOUD_ROBOT_HOME: "*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" ident)" "$(field "$OUT" source)"

# K7b: GCLOUD_ROBOT_ACCOUNT — the documented robot-first guarantee lever — is
# forwarded to the selector and selected (the selector probes the env account
# first; the bridge must not scrub or starve it).
OUT=$(run_ladder "run.jobs.run" HOME="$WK2_HOME" GCLOUD_ROBOT_ACCOUNT="guaranteed-robot@example.invalid")
check "K7b GCLOUD_ROBOT_ACCOUNT is forwarded to the selector and wins the probe" \
  bash -c '
    [ "$1" = "guaranteed-robot@example.invalid" ] &&
    grep -q "^account=guaranteed-robot@example.invalid$" "$2.env"
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# K9: a repeat resolve in the same process (e.g. cmd_run -> cmd_build) keeps
# the FIRST resolve's attribution even when the pin slot is now occupied.
OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      SELECTOR_ACCOUNT="probe-robot@example.invalid" \
      bash -c '
        set -u
        . "$1"
        GCP_PROJECT="misc-puttering-project"
        GCP_ACCOUNT=""
        freshell_resolve_cloud_identity "run.jobs.run"
        first="${FRESHELL_GCP_IDENTITY_SOURCE:-}"
        GCP_ACCOUNT="later-pin@example.invalid"
        freshell_resolve_cloud_identity "cloudbuild.builds.create"
        printf "first=%s\nsecond=%s\n" "$first" "${FRESHELL_GCP_IDENTITY_SOURCE:-}"
      ' _ "$HELPER" 2>/dev/null || true)
check "K9 repeat resolve after a later pin keeps the first resolve's attribution" \
  bash -c '
    case "$1" in "gcloud-robot probe (GCLOUD_ROBOT_HOME: "*) ;; *) exit 1;; esac
    [ "$1" = "$2" ]
  ' _ "$(field "$OUT" first)" "$(field "$OUT" second)"

# K8: source attribution for the other rungs.
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="env-ident@example.invalid")
check "K8 GCLOUD_IDENT bypass attributes to the GCLOUD_IDENT source" \
  bash -c '
    [ "$1" = "env-ident@example.invalid" ] &&
    [ "$2" = "GCLOUD_IDENT (explicit env bypass)" ]
  ' _ "$(field "$OUT" ident)" "$(field "$OUT" source)"
OUT=$(run_ladder "run.jobs.run" FRESHELL_GCP_ACCOUNT="pin@example.invalid")
check "K8b pin attributes to the pin source" \
  bash -c '[ "$1" = "pin (--account flag or FRESHELL_GCP_ACCOUNT)" ]' _ "$(field "$OUT" source)"
```

Also extend the W7 trap (after the existing W7 loop, lines 386–395) with a hostile-`HOME` variant:

```bash
# --- W7b: the pre-existing stubbed suites are probe-proof against
# well-known-path discovery too (trap 11): each pins GCLOUD_IDENT internally,
# and the bridge must never even discover when GCLOUD_IDENT is set — so a
# hostile HOME full of marker-writing failing installs must stay untouched.
# cloud-run-wrapper is deliberately NOT in this loop: its real cargo +
# Playwright local legs need ~/.rustup and ~/.cache/ms-playwright, so it dies
# at check 4 under a hostile HOME — BEFORE any bridge-relevant invocation —
# making a marker-only assertion here vacuous. It stays covered by W7
# (hostile GCLOUD_ROBOT_HOME under real HOME, green at base — verified
# 2026-09-21) plus its top-of-file GCLOUD_IDENT pin.
HOSTILE_HOME="$TDIR/home-w7b"; mkdir -p "$HOSTILE_HOME"
mk_marker_robot_install "$HOSTILE_HOME" ".codex/skills/gcloud-robot"
for nested in scripts/test/cloud-build.test.sh \
              scripts/test/cloud-exec-id-parse.test.sh \
              scripts/test/cloud-vitest-wrapper.test.sh; do
  rm -f "$SELECTOR_MARKER"
  env "${SCRUB[@]}" HOME="$HOSTILE_HOME" SELECTOR_FAIL=1 \
    bash "$nested" >"$TDIR/nested-w7b.log" 2>&1 && NESTED_RC=0 || NESTED_RC=$?
  check "W7b trap-11: $nested green and probe-free under hostile well-known HOME" \
    bash -c '[ "$1" = "0" ] && [ ! -e "$2" ]' _ "$NESTED_RC" "$SELECTOR_MARKER"
done
```

(Live-proven 2026-09-21: all three of these suites are green under a hostile empty/marker `HOME` — cloud-build and cloud-vitest-wrapper directly, cloud-exec-id-parse after the Pre-step 0 repair. cloud-run-wrapper is red under hostile HOME at check 4 for toolchain reasons — see the loop comment.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL — the K checks fail for the missing behavior: K1/K2/K2b/K2c see an empty `ident` (no discovery exists), K7b sees the selector return the scrubbed empty account instead of the forwarded `GCLOUD_ROBOT_ACCOUNT`, K5/K6 miss the new note, K8/K8b see an empty `source=` (bridge never sets it), K9 sees empty attribution on both resolves. Every pre-existing A–J/W check must still PASS after the harness retrofit (nothing reads `HOME` yet, so the retrofit alone is behavior-neutral). If any pre-existing check fails after the retrofit alone, fix the retrofit first — that is a harness bug, not the intended red.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/lib/gcp-identity.sh`:

1. Rewrite the header comment (lines 10–15) to the new contract: the drop-in block stays verbatim and untouched; run-time discovery happens via `GCLOUD_ROBOT_HOME` **or** the Freshell bridge's well-known-path probe (list the three paths in order), which pre-fills `GCLOUD_ROBOT_HOME` before the untouched ladder runs. Also extend the ladder comment (lines 17–25) rung-3 line to mention the bridge-owned defaulting.

2. Add before the bridge:

```bash
# Well-known gcloud-robot install locations, in probe order (kata e83z). All
# are $HOME-relative so hermetic tests control them via HOME. A candidate is
# a real install only when its select-gcloud-identity.sh is a present,
# executable regular file (the skill's own validity contract).
freshell_discover_robot_home() {
  local candidate selector
  for candidate in \
    "${HOME:-}/.codex/skills/gcloud-robot" \
    "${HOME:-}/.claude/skills/gcloud-robot" \
    "${HOME:-}/code/skill-gcloud-robot/gcloud-robot"; do
    selector="$candidate/scripts/select-gcloud-identity.sh"
    if [ -f "$selector" ] && [ -x "$selector" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
```

3. Extend the bridge, preserving its existing external contract exactly (rung-1 pin first; `$1` dereferenced only at the `GCLOUD_ROBOT_PROBE_PERMISSION` line so a pinned no-arg call still succeeds; `GCP_ACCOUNT="${GCLOUD_IDENT:-}"` adoption; `return 1` propagation):

```bash
freshell_resolve_cloud_identity() {
  # rung 1: an existing pin (the wrapper's --account= flag or
  # FRESHELL_GCP_ACCOUNT) wins outright — skip the ladder ENTIRELY: no
  # selector, no network, no stderr note, and GCLOUD_ROBOT_REQUIRE=1 must not
  # fail a deliberately pinned call. A pin that appears only AFTER a first
  # resolve in the same process is an adopted identity, not a pin: the
  # GCLOUD_IDENT_RESOLVED guard keeps the first resolve's attribution
  # (kata e83z; pinned by check K9).
  if [ -n "${GCP_ACCOUNT:-}" ] && [ -z "${GCLOUD_IDENT_RESOLVED:-}" ]; then
    FRESHELL_GCP_IDENTITY_SOURCE="pin (--account flag or FRESHELL_GCP_ACCOUNT)"
    return 0
  fi
  if [ -n "${GCLOUD_IDENT_RESOLVED:-}" ]; then
    return 0
  fi
  export GCLOUD_ROBOT_PROJECT="${GCLOUD_ROBOT_PROJECT:-${GCP_PROJECT:?GCP_PROJECT must be set before identity resolution}}"
  export GCLOUD_ROBOT_PROBE_PERMISSION="${GCLOUD_ROBOT_PROBE_PERMISSION:-${1:?probe permission argument required}}"
  # kata e83z: when nothing pins or bypasses the ladder, default the robot
  # home from the well-known install locations before the (untouched) ladder
  # runs, so machines with a standard install resolve the robot without any
  # shell having sourced an rc file.
  local pre_ident="${GCLOUD_IDENT:-}" discovered_home=""
  if [ -z "$pre_ident" ] && [ -z "${GCLOUD_ROBOT_HOME:-}" ]; then
    if discovered_home="$(freshell_discover_robot_home)"; then
      export GCLOUD_ROBOT_HOME="$discovered_home"
      FRESHELL_ROBOT_HOME_DISCOVERED=1
    fi
  fi
  local probe_will_run=0
  if [ -n "${GCLOUD_ROBOT_HOME:-}" ] && [ -x "${GCLOUD_ROBOT_HOME:-}/scripts/select-gcloud-identity.sh" ]; then
    probe_will_run=1
  fi
  local resolved_ok=0
  if resolve_gcp_identity; then resolved_ok=1; fi
  GCP_ACCOUNT="${GCLOUD_IDENT:-}"
  if [ -n "$pre_ident" ]; then
    FRESHELL_GCP_IDENTITY_SOURCE="GCLOUD_IDENT (explicit env bypass)"
  elif [ -n "${GCLOUD_IDENT:-}" ]; then
    if [ -n "${FRESHELL_ROBOT_HOME_DISCOVERED:-}" ]; then
      FRESHELL_GCP_IDENTITY_SOURCE="gcloud-robot probe (well-known install: $GCLOUD_ROBOT_HOME)"
    else
      FRESHELL_GCP_IDENTITY_SOURCE="gcloud-robot probe (GCLOUD_ROBOT_HOME: $GCLOUD_ROBOT_HOME)"
    fi
  elif [ "$probe_will_run" = "1" ]; then
    if [ -n "${FRESHELL_ROBOT_HOME_DISCOVERED:-}" ]; then
      FRESHELL_GCP_IDENTITY_SOURCE="ambient gcloud (well-known install produced no identity: $GCLOUD_ROBOT_HOME)"
      echo "gcloud-robot: well-known install at $GCLOUD_ROBOT_HOME produced no identity" >&2
    else
      FRESHELL_GCP_IDENTITY_SOURCE="ambient gcloud (probe produced no identity)"
    fi
  else
    FRESHELL_GCP_IDENTITY_SOURCE="ambient gcloud (no robot skill found)"
  fi
  [ "$resolved_ok" = "1" ] || return 1
}
```

Notes on this shape: the `GCLOUD_IDENT_RESOLVED` early-return at the top preserves the external contract exactly (repeat calls were already no-ops via the ladder's own guard + the rung-1 branch) while keeping the FIRST resolve's attribution and adoption stable across the multi-resolve lanes (`cmd_run` → rebuild → `cmd_build` calls the bridge a second time; without the guard, an adopted probe identity would be mislabeled `pin` on the second call). `freshell_discover_robot_home` never runs on repeat calls for the same reason. The skill drop-in block (lines 27–51) is NOT edited: with `GCLOUD_ROBOT_HOME` pre-filled by the bridge its rung-3 runs unchanged; with nothing discovered it stays unset and line 45's note fires byte-identically (`${GCLOUD_ROBOT_HOME:-<unset>}` renders `<unset>`).

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS (all pre-existing + new K/W7b checks).

- [ ] **Step 5: Refactor while green**

Fold the two install-builder helpers into one if it reads cleaner, keep the three candidate paths as the single shared list between helper and production, and re-run the focused test.

- [ ] **Step 6: Run impacted-test verification**

The ladder is consumed only by the two wrappers; the bash suites exercise them:

Run: `for s in scripts/test/cloud-*.test.sh scripts/test/e2e-harness-timeout-env.test.sh; do echo "== $s"; bash "$s" || exit 1; done`

Expected: PASS. All sibling suites are shielded by their top-of-file `GCLOUD_IDENT` pins, which the bridge honors (discovery never runs when `GCLOUD_IDENT` is set) — W7b proves exactly this.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/lib/gcp-identity.sh scripts/test/cloud-gcp-identity.test.sh
git commit -m "feat(cloud): discover well-known gcloud-robot installs in the identity bridge (kata e83z)"
```

---

### Task 2: TTY-gated prompt disabling + identity preflight in both wrappers

**Files:**
- Modify: `scripts/vitest-cloud.sh` (top-of-script export; `identity_preflight()` beside `account_flag()` ~line 140; calls after the resolve sites — by current line numbers 230, 293, 429, 655)
- Modify: `scripts/e2e-cloud.sh` (same, `[e2e-cloud]` prefix; resolve sites 245, 308, 481, 820)
- Test: `scripts/test/cloud-vitest-wrapper.test.sh` (new FAKE8 + checks)
- Test: `scripts/test/cloud-build.test.sh` (marker line in the existing fake; new checks)
- Test: `scripts/test/cloud-gcp-identity.test.sh` (new W14: e2e run-lane preflight + prompts; EXTEND the existing W12c/W12d standalone push/logs checks with preflight-order assertions so all four resolve sites per wrapper are covered)

**Interfaces:**
- Consumes: Task 1's bridge (`FRESHELL_GCP_IDENTITY_SOURCE`, discovery), `account_flag()`, the existing fakes' `auth print-access-token` stubs.
- Produces: `identity_preflight()` in both wrappers (loud two-line stderr error + `exit 1` when the token mint fails); a process-env export `CLOUDSDK_CORE_DISABLE_PROMPTS=1` visible to every child gcloud call (including the selector) when stdin is not a TTY.

- [ ] **Step 1: Write the failing behavioral tests**

In `scripts/test/cloud-vitest-wrapper.test.sh` — the suite pins `GCLOUD_IDENT="suite-pinned-identity@example.invalid"` (line 15) so the ladder is bypassed and every fake gcloud call is pinned. Add a new fake plus suite-level invocation helpers (following the suite's FAKE..FAKE7 rewrite pattern; all wrapper invocations at SUITE level, `check` greps via positional args):

```bash
# FAKE8: prompts-env recording + failing-token mode (kata e83z)
FAKE8_DIR=$(mktemp -d)
FAKE8_LOG="$FAKE8_DIR/gcloud.log"
export FAKE8_LOG
cat > "$FAKE8_DIR/gcloud" << 'FAKE8'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE8_LOG:?set FAKE8_LOG}"
[ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && echo "PROMPTS_DISABLED=1" >> "$FAKE8_LOG"
case "$*" in
  *"auth print-access-token"*)
    if [ -n "${FAKE8_TOKEN_FAIL:-}" ]; then
      echo "Reauthentication failed. cannot prompt during non-interactive execution" >&2
      exit 1
    fi
    echo fake-token; exit 0 ;;
  *"info"*) echo "/nonexistent-sdk-root"; exit 0 ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"artifacts repositories describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*) exit 0 ;;
  *"run jobs execute"*) printf 'Execution [fake8-exec-1] has successfully completed.\n'; exit 0 ;;
  *"executions list"*) echo "fake8-exec-1"; exit 0 ;;
  *"executions describe"*) echo 1; exit 0 ;;
  *"logs read"*) echo "  1 passed (1.0s)"; exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *) exit 0 ;;
esac
FAKE8
chmod +x "$FAKE8_DIR/gcloud"

run8() { # suite-level helper: run the run lane under FAKE8; stdin: caller's
  rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
  PATH="$FAKE8_DIR:$PATH" bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1
}
```

New checks (suite-level invocations, then `check`):

```bash
V8_OUT=$(run8 < /dev/null) && V8_RC=0 || V8_RC=$?
check "non-TTY stdin exports CLOUDSDK_CORE_DISABLE_PROMPTS=1 to gcloud children" \
  bash -c 'grep -q "PROMPTS_DISABLED=1" "$1"' _ "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
T8_DIR="$FAKE8_DIR" # pass through positional args for the script(1) run
check "TTY stdin leaves prompts enabled (humans keep interactive reauth)" \
  bash -c '
    script -qec "env PATH=\"$1:\$PATH\" bash \"$2\" run --cloud --config=default --shards=2" /dev/null >/dev/null 2>&1 || true
    ! grep -q "PROMPTS_DISABLED=1" "$3"
  ' _ "$FAKE8_DIR" "$SCRIPT" "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V8S_OUT=$(run8 < /dev/null) >/dev/null 2>&1 || true
check "identity preflight mints a token before any build/submit work" \
  bash -c '
    tok_line="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok_line" ] || exit 1
    if awk -v n="$tok_line" "NR<n" "$1" | grep -qE "FAKE_GCLOUD:.*(builds submit|run jobs create)"; then exit 1; fi
    grep -q "FAKE_GCLOUD: auth print-access-token --account=suite-pinned-identity@example.invalid" "$1"
  ' _ "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V8F_OUT=$(PATH="$FAKE8_DIR:$PATH" FAKE8_TOKEN_FAIL=1 bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1 < /dev/null) && V8F_RC=0 || V8F_RC=$?
check "failed preflight exits fast: no builds submit, no job create, loud attributable error" \
  bash -c '
    [ "$1" != "0" ] &&
    grep -q "identity preflight failed for suite-pinned-identity@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$2" &&
    ! grep -qE "FAKE_GCLOUD:.*(builds submit|run jobs create)" "$3"
  ' _ "$V8F_RC" "$V8F_OUT" "$FAKE8_LOG"
```

In `scripts/test/cloud-build.test.sh`: add one line to the existing fake gcloud heredock (after its `FAKE_GCLOUD: $@` log line):

```bash
[ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && echo "PROMPTS_DISABLED=1" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
```

then add after the existing build-lane checks:

```bash
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash scripts/vitest-cloud.sh build >/dev/null 2>&1 </dev/null || true
check "vitest build lane: prompts disabled (non-TTY) + preflight token mint precedes builds submit" \
  bash -c '
    grep -q "PROMPTS_DISABLED=1" "$1" || exit 1
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    sub="$(grep -n "builds submit" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$sub" ] && [ "$tok" -lt "$sub" ]
  ' _ "$FAKE_GCLOUD_LOG"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash scripts/e2e-cloud.sh build >/dev/null 2>&1 </dev/null || true
check "e2e build lane: prompts disabled (non-TTY) + preflight token mint precedes builds submit" \
  bash -c '
    grep -q "PROMPTS_DISABLED=1" "$1" || exit 1
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    sub="$(grep -n "builds submit" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$sub" ] && [ "$tok" -lt "$sub" ]
  ' _ "$FAKE_GCLOUD_LOG"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
check "e2e build lane under a real TTY leaves prompts enabled" \
  bash -c '
    script -qec "env PATH=\"$1:\$PATH\" bash scripts/e2e-cloud.sh build" /dev/null >/dev/null 2>&1 || true
    ! grep -q "PROMPTS_DISABLED=1" "$2"
  ' _ "$FAKE_DIR" "$FAKE_GCLOUD_LOG"
```

In `scripts/test/cloud-gcp-identity.test.sh`: add the same marker line to the green fake (`GREEN_FAKE`, after its `GCLOUD_ARGS` log line), then add W14 (copying the W5 invocation idiom verbatim, adding `HOME` + stdin + a pinned GCLOUD_IDENT):

```bash
# --- W14: e2e run lane — preflight + prompts env reach the green fake -------
reset_green
W14_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null < /dev/null) && W14_RC=0 || W14_RC=$?
check "W14 e2e run: preflight token mint precedes run jobs create; prompts disabled on non-TTY stdin" \
  bash -c '
    [ "$1" = "0" ] || exit 1
    tok="$(grep -n "auth print-access-token" "$2" | head -1 | cut -d: -f1)"
    create="$(grep -n "run jobs create" "$2" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$create" ] && [ "$tok" -lt "$create" ] &&
    grep -q "PROMPTS_DISABLED=1" "$2"
  ' _ "$W14_RC" "$GREEN_LOG"
check "W14 e2e run: every gcloud call still pinned (preflight included)" \
  accounts_all_equal "$RUNG2_IDENT"
```

Also EXTEND the existing W12c and W12d checks so the standalone `push` and `logs` lanes prove their own preflights (omitting either call site would otherwise stay green — `push` already mints later for docker login and `logs` has no direct token assertion). Append to each check's snippet (the W-series positional-args idiom), reading `$GREEN_LOG` after the existing invocation:

```bash
# W12c (e2e standalone push) — add:
check "W12c e2e standalone push: preflight token mint precedes all lane work" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -nE "GCLOUD_ARGS:.*(artifacts repositories describe|builds submit)" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"

# W12d (e2e standalone logs) — add:
check "W12d e2e standalone logs: preflight token mint precedes the executions list" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -n "GCLOUD_ARGS:.*executions list" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"
```

(The vitest standalone lanes W13b/W13c get the same treatment — the run/push/logs preflight contract is per resolve site in BOTH wrappers. For W13b assert the mint precedes `artifacts repositories describe`; for W13c precedes `executions list`.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh && bash scripts/test/cloud-build.test.sh && bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL — the substantive new checks fail (no `PROMPTS_DISABLED` marker is written on non-TTY runs; no `auth print-access-token` precedes `builds submit`/`run jobs create`; the failure-mode check sees the lane proceed past identity). The two TTY-side absence checks pass VACUOUSLY before implementation (nothing writes the marker at all yet) — they become meaningful only once the marker line exists; that is expected, not a red-expectation violation. All pre-existing checks still pass.

- [ ] **Step 3: Add the minimal production implementation**

In BOTH wrappers (identical modulo prefix):

1. Immediately after the defaults block (after the `IMAGE_*` defaults, near the `SCRIPT_DIR`/`ROOT` setup, before any subcommand dispatch):

```bash
# kata e83z: non-TTY stdin is the agent case (bash -c, tool harnesses, CI).
# The identity preflight below is the guaranteed fail-fast leg; this export is
# defense-in-depth — verified in gcloud's CanPrompt() source to be honored as
# the --quiet equivalent even where auto-detection does not apply. Humans at
# a real terminal keep interactive reauth (the export is deliberately withheld
# on TTY stdin).
if [ ! -t 0 ]; then
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1
fi
```

2. Beside `account_flag()` add (vitest text shown; e2e uses `[e2e-cloud]`):

```bash
# kata e83z: cheap live-credential check at lane start — fails in seconds,
# before any build/submit work, when the resolved identity cannot mint a token.
# The error names the resolved identity and its source so the failure path is
# as attributable as the success path.
identity_preflight() {
  if ! gcloud auth print-access-token $(account_flag) >/dev/null 2>&1; then
    echo "[vitest-cloud] ERROR: identity preflight failed for ${GCP_ACCOUNT:-(ambient gcloud)} (source: ${FRESHELL_GCP_IDENTITY_SOURCE:-unresolved}) - gcloud auth print-access-token could not mint a token." >&2
    echo "[vitest-cloud] Fix the credential/identity (docs/development/gcloud-robot.md) and re-run the lane." >&2
    exit 1
  fi
}
```

3. Call `identity_preflight` immediately after each of the four `freshell_resolve_cloud_identity` call sites in each wrapper (locate the existing calls, not stale line numbers).

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh && bash scripts/test/cloud-build.test.sh && bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

`cmd_run` enters `cmd_build` on the rebuild path whose own resolve+preflight then no-ops (ladder idempotency guard); the extra preflight token mint is a cheap no-op — uniform placement stays. Rerun the focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `for s in scripts/test/cloud-*.test.sh scripts/test/e2e-harness-timeout-env.test.sh; do echo "== $s"; bash "$s" || exit 1; done`

Expected: PASS. The preflight adds one pinned `--account=` token per resolve site crossed (a green-fake run lane crosses two: `cmd_run`'s resolve and `cmd_build`'s on the rebuild path — each is a real ~1s token mint); call count and token count grow together, so `accounts_all_equal` tolerates it by design; ambient runs log the calls with no token, so W5/W6b's absent-accounts-file proof still holds — verify those two checks explicitly in the output.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/vitest-cloud.sh scripts/e2e-cloud.sh scripts/test/cloud-vitest-wrapper.test.sh scripts/test/cloud-build.test.sh scripts/test/cloud-gcp-identity.test.sh
git commit -m "feat(cloud): fail-fast identity for agent cloud lanes - TTY-gated prompt disable + token preflight (kata e83z)"
```

---

### Task 3: Startup-banner identity attribution + loud dirty-tree surfacing

**Files:**
- Modify: `scripts/vitest-cloud.sh` (run-lane banner ~lines 466–471; tag recompute 435–437)
- Modify: `scripts/e2e-cloud.sh` (run-lane banner ~lines 520–525; tag recompute 487–489)
- Test: `scripts/test/cloud-vitest-wrapper.test.sh` (banner identity + dirty WARNING checks, using FAKE8 from Task 2)
- Test: `scripts/test/cloud-gcp-identity.test.sh` (W15: e2e banner identity, ambient attribution with the stderr proof intact, dirty WARNING)

**Interfaces:**
- Consumes: Task 1's `FRESHELL_GCP_IDENTITY_SOURCE` (a plain shell var in the wrapper process — the bridge is sourced, not subshelled), `image_tag_for_head()`'s existing `-dirty` sentinel, Task 2's FAKE8/W14 plumbing.
- Produces: one stdout lane-start line `Identity: <account-or-(ambient gcloud)> (source: <FRESHELL_GCP_IDENTITY_SOURCE>)` and, when the computed image tag ends `-dirty`, one stdout `WARNING: dirty worktree` line — BOTH printed in `cmd_run` immediately after `identity_preflight`, BEFORE the image-lookup/rebuild decision block (so they lead the lane output and precede any possibly ~13-minute build work; the existing 5-line `Running on Cloud Run Jobs...` block keeps its position after that block). The existing mid-run dirty lines (vitest 451 / e2e 503) stay unchanged. The preflight failure path (Task 2) independently names the identity and source in its error text, so the failure path is attributable too.

- [ ] **Step 1: Write the failing behavioral tests**

In `scripts/test/cloud-vitest-wrapper.test.sh` (suite-level invocations; the top-of-file `GCLOUD_IDENT` pin makes the identity deterministic):

```bash
rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V9_OUT=$(run8 < /dev/null) || true
check "run-lane startup banner reports the resolved identity and its source" \
  bash -c '
    grep -q "\[vitest-cloud\] Identity: suite-pinned-identity@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$1"
  ' _ "$V9_OUT"
check "identity line leads the lane output (before the Running-on-Cloud-Run banner)" \
  bash -c '
    ident="$(grep -n "\[vitest-cloud\] Identity:" <<<"$1" | head -1 | cut -d: -f1)"
    banner="$(grep -n "Running on Cloud Run Jobs" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$ident" ] && [ -n "$banner" ] && [ "$ident" -lt "$banner" ]
  ' _ "$V9_OUT"

V10_DIRTY="$ROOT/.vitest-cloud-dirty-check-$$"
touch "$V10_DIRTY"
rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V10_OUT=$(run8 < /dev/null) || true
rm -f "$V10_DIRTY"
check "loud stdout WARNING when the -dirty image path is taken" \
  bash -c '
    grep -q "WARNING: dirty worktree" <<<"$1" &&
    grep -q "not content-addressed" <<<"$1"
  ' _ "$V10_OUT"
check "dirty WARNING leads the lane output (surfaced BEFORE any rebuild work)" \
  bash -c '
    warn="$(grep -n "WARNING: dirty worktree" <<<"$1" | head -1 | cut -d: -f1)"
    banner="$(grep -n "Running on Cloud Run Jobs" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$warn" ] && [ -n "$banner" ] && [ "$warn" -lt "$banner" ]
  ' _ "$V10_OUT"
```

(The dirty check creates a temporary untracked file so the WARNING is guaranteed regardless of the checkout's ambient state, and removes it immediately after the run. Suite-level invocation via `run8` keeps all fixtures in scope. The FAKE8 `builds submit` stub absorbs the dirty-rebuild branch. The ordering checks pin the placement requirement: the identity and dirty lines print BEFORE the build-decision block can spend ~13 minutes in `cmd_build` — a grep-only assertion would pass with the lines printed anywhere, including after the rebuild.)

In `scripts/test/cloud-gcp-identity.test.sh`, after W14 (same invocation idiom):

```bash
# --- W15: e2e run-lane banner attribution (stdout) + untouched stderr proof --
reset_green
W15_ERR="$TDIR/w15.err"
W15_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15_ERR" < /dev/null) && W15_RC=0 || W15_RC=$?
check "W15 e2e banner: pinned identity + GCLOUD_IDENT source on stdout" \
  bash -c '
    grep -q "\[e2e-cloud\] Identity: rung2-bypass@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$2"
  ' _ "$W15_RC" "$W15_OUT"
check "W15 e2e banner: identity line precedes the Running-on-Cloud-Run block" \
  bash -c '
    ident="$(grep -n "\[e2e-cloud\] Identity:" <<<"$2" | head -1 | cut -d: -f1)"
    banner="$(grep -n "Running on Cloud Run Jobs" <<<"$2" | head -1 | cut -d: -f1)"
    [ -n "$ident" ] && [ -n "$banner" ] && [ "$ident" -lt "$banner" ]
  ' _ "$W15_RC" "$W15_OUT"

reset_green
W15B_ERR="$TDIR/w15b.err"
W15B_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15B_ERR" < /dev/null) && W15B_RC=0 || W15B_RC=$?
check "W15b e2e ambient banner: (ambient gcloud) identity + no-robot-skill source; stderr still exactly the one ambient note" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -q "\[e2e-cloud\] Identity: (ambient gcloud) (source: ambient gcloud (no robot skill found))" <<<"$2" &&
    [ "$(wc -l < "$3")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$3"
  ' _ "$W15B_RC" "$W15B_OUT" "$W15B_ERR"

W15C_ERR="$TDIR/w15c.err"
W15C_DIRTY="$ROOT/.e2e-cloud-dirty-w15c"
touch "$W15C_DIRTY"
W15C_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15C_ERR" < /dev/null) && W15C_RC=0 || W15C_RC=$?
rm -f "$W15C_DIRTY"
check "W15c e2e dirty tree: loud WARNING banner line on stdout, before the rebuild" \
  bash -c '
    grep -q "\[e2e-cloud\] WARNING: dirty worktree" <<<"$2" &&
    grep -q "not content-addressed" <<<"$2" &&
    warn="$(grep -n "WARNING: dirty worktree" <<<"$2" | head -1 | cut -d: -f1)"
    banner="$(grep -n "Running on Cloud Run Jobs" <<<"$2" | head -1 | cut -d: -f1)"
    [ -n "$warn" ] && [ -n "$banner" ] && [ "$warn" -lt "$banner" ]
  ' _ "$W15C_RC" "$W15C_OUT"
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh && bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL — no `Identity:` banner line and no `WARNING: dirty worktree` line exist yet; pre-existing checks still pass.

- [ ] **Step 3: Add the minimal production implementation**

In `cmd_run` of BOTH wrappers, immediately AFTER the `identity_preflight` call and the tag recompute, and BEFORE the image-lookup/rebuild decision block (vitest: before the `gcloud artifacts docker images describe` at ~460; e2e: before the `describe`/dirty/missing chain at ~509 — locate the resolve+preflight and the decision block, not stale numbers). This placement is load-bearing: the build decision can run a ~13-minute `cmd_build` before the existing `Running on Cloud Run Jobs...` block, and the identity/dirty lines must lead the lane output, not trail the build:

```bash
if [[ "$image_tag" == *-dirty ]]; then
  echo "[vitest-cloud] WARNING: dirty worktree - image tag ${image_tag} is not content-addressed; this run cold-rebuilds the image (~13 min) and the result is not reusable."
fi
echo "[vitest-cloud] Identity: ${GCP_ACCOUNT:-(ambient gcloud)} (source: ${FRESHELL_GCP_IDENTITY_SOURCE:-unresolved})"
```

(e2e identical modulo `[e2e-cloud]`.) Both lines go to stdout; the existing mid-run dirty lines (451/503) and the existing banner block are untouched — the existing block keeps printing Image/Shards/Timeout/Configs/Args after the build decision exactly as today.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-vitest-wrapper.test.sh && bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep the two wrappers' banner blocks byte-identical modulo prefix; no other refactor expected. Rerun the focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `for s in scripts/test/cloud-*.test.sh scripts/test/e2e-harness-timeout-env.test.sh; do echo "== $s"; bash "$s" || exit 1; done`

Expected: PASS — including `cloud-run-wrapper.test.sh` (its check 11 computes a conditional `EXPECTED_TAG` and greps the fake log, not wrapper stdout; its job-name regex already tolerates `-dirty`; its wrapper invocations inherit stdin, and the WARNING goes to stdout so its assertions are unaffected — verify in output).

- [ ] **Step 7: Commit the task**

```bash
git add scripts/vitest-cloud.sh scripts/e2e-cloud.sh scripts/test/cloud-vitest-wrapper.test.sh scripts/test/cloud-gcp-identity.test.sh
git commit -m "feat(cloud): report resolved identity/source and loud dirty-tree state in lane banners (kata e83z)"
```

---

### Task 4: Docs — AGENTS.md test-coordination recommendation, ladder wording, runbook, wrapper help text

**Files:**
- Modify: `AGENTS.md` (Test Coordination bullet list, lines 32–39; both Identity paragraphs 181–187 and 205–211 — kept byte-identical to each other)
- Modify: `docs/development/gcloud-robot.md` (ladder section lines 40–59; Operator setup lines 115–132; Troubleshooting lines 348–394)
- Modify: `scripts/vitest-cloud.sh` + `scripts/e2e-cloud.sh` (`usage()` identity text: vitest 174–179, e2e 188–193)
- Test: `scripts/test/cloud-gcp-identity.test.sh` (W10b/W10c help-text assertions)

**Interfaces:**
- Consumes: Tasks 1–3 behavior (discovery, TTY gate, preflight, banner).
- Produces: documentation only, plus wrapper help-text updates that their existing help-grep checks (W10/W11) must still pass.

- [ ] **Step 1: Write the failing behavioral tests**

In `scripts/test/cloud-gcp-identity.test.sh`, next to the W10/W11 block (lines 551–561):

```bash
check "W10b both wrappers' help documents well-known install discovery" \
  bash -c '
    grep -q "well-known gcloud-robot install" <<<"$1" && grep -q "well-known gcloud-robot install" <<<"$2"
  ' _ "$E2E_HELP" "$VITEST_HELP"
check "W10c both wrappers' help documents non-TTY fail-fast prompt behavior" \
  bash -c '
    grep -q "CLOUDSDK_CORE_DISABLE_PROMPTS" <<<"$1" && grep -q "CLOUDSDK_CORE_DISABLE_PROMPTS" <<<"$2"
  ' _ "$E2E_HELP" "$VITEST_HELP"
```

(The strings are absent from both help texts today, so both checks fail for the right reason. Help text is user-visible behavior of the scripts; the existing W10/W11 knob-name checks keep passing because all four knob names stay.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: FAIL — W10b/W10c strings absent; all other checks pass.

- [ ] **Step 3: Add the minimal production implementation**

1. `AGENTS.md` — add one bullet to the Test Coordination list, after the base-gate bullet:

```markdown
- Agent-launched broad gates should export `GCLOUD_ROBOT_REQUIRE=1` (the recommended default): fail closed when no robot identity resolves, instead of silently running as a possibly-stale human identity. Machines with a standard gcloud-robot install don't need `GCLOUD_ROBOT_HOME` exported — the lanes probe the well-known install locations (`~/.codex/skills/gcloud-robot`, `~/.claude/skills/gcloud-robot`, `~/code/skill-gcloud-robot/gcloud-robot`) when it's unset, and non-TTY (agent) invocations disable gcloud prompts and preflight the credential so a dead identity fails in seconds instead of hanging. To guarantee the robot identity itself — rather than the selector's first passing candidate — export `GCLOUD_ROBOT_ACCOUNT=<robot>`: the selector probes that account first, so no other identity (including an ambient human with lane permissions) can win; for PTY-launched agent lanes (Freshell terminal panes, where prompts are deliberately NOT disabled) this also prevents the selector from ever minting the ambient human credential.
```

(The last sentence documents both the robot-first guarantee lever and this change's own PTY residual — required for honest documentation; the mechanism is live-verified: the selector probes the env-pinned account first. Without it, the selector's documented candidate policy can legitimately pick a LIVE human that holds lane permissions over the robot — a state the lanes' runbook records as the selector's intended behavior, but not what "robot by default" means. `GCLOUD_ROBOT_REQUIRE=1` does NOT close that gap; only `GCLOUD_ROBOT_ACCOUNT` does.)

2. `AGENTS.md` — update BOTH Identity paragraphs identically: replace `gcloud-robot probe (needs `GCLOUD_ROBOT_HOME`, the installed gcloud-robot skill directory)` with `gcloud-robot probe (via `GCLOUD_ROBOT_HOME`, or the first well-known gcloud-robot skill install: `~/.codex/skills/gcloud-robot`, `~/.claude/skills/gcloud-robot`, `~/code/skill-gcloud-robot/gcloud-robot`)`. The two paragraphs stay byte-identical to each other.

3. `docs/development/gcloud-robot.md`:
   - Ladder section rung 4: same wording change as the Identity paragraphs.
   - "Adoption states" section 1 ("wired but not yet provisioned ... lanes run exactly as before"): now stale for machines with a well-known-path install — update to say such machines resolve the robot via discovery (the selector runs; a second stderr note can appear when the probe fails).
   - Operator setup, after the `GCLOUD_ROBOT_HOME` export block: "On machines with a standard install the export is optional — the lanes probe the well-known locations in order when `GCLOUD_ROBOT_HOME` is unset; an explicit export still wins."
   - Broker section (OneCLI gateway broker), add: "The identity preflight mints via oauth2.googleapis.com, which the gateway deliberately does not broker: on brokered hosts, a lane whose resolved identity has a dead LOCAL credential now fails fast at the preflight instead of succeeding silently via brokered control-plane hosts. Keep the robot key activated (`scripts/bootstrap-robot.sh`) or pin `GCLOUD_IDENT` on such machines."
   - Troubleshooting, add a two-shape entry: "An agent-launched lane (non-TTY stdin) fails within seconds at the identity preflight with `Reauthentication failed. cannot prompt during non-interactive execution` — the expected fail-fast shape (live-verified: the malformed-token subclass also fails fast and never prompts). A lane under a real TTY with a reauth-required human credential still blocks interactively on `Reauthentication required.` / `Please enter your password:` (the prompt class that produced the multi-hour incident; discovery moves this blockage EARLIER, inside the resolve, with the selector's output swallowed) — pin `GCLOUD_ROBOT_ACCOUNT` (the selector probes it first and never mints the human) or `GCLOUD_IDENT` on PTY-launched agent lanes. A `gcloud-robot: well-known install at ... produced no identity` note means a standard install exists but its probe failed — see the selector's stderr guidance."

4. Both wrappers' `usage()` identity text: mirror the same ladder wording change as AGENTS.md plus one line documenting the non-TTY prompt disable + preflight. The text MUST contain the exact substring `well-known gcloud-robot install` (the string W10b greps — write it deliberately; do not let a paraphrase like "well-known gcloud-robot skill install" break the check) and the exact token `CLOUDSDK_CORE_DISABLE_PROMPTS` (W10c).

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-gcp-identity.test.sh`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Re-read the three doc surfaces for consistency (AGENTS.md paragraphs byte-identical to each other; wrapper help mirrors AGENTS.md wording; the runbook stays the deep reference). The Test Coordination bullet is the only place the recommended-default guidance lives, per the constraint.

- [ ] **Step 6: Run impacted-test verification**

Run: `for s in scripts/test/cloud-*.test.sh scripts/test/e2e-harness-timeout-env.test.sh; do echo "== $s"; bash "$s" || exit 1; done`

Expected: PASS. No TypeScript/Rust files changed — the pre-push gate's changed-file filters match nothing; state that reasoning in the task report.

- [ ] **Step 7: Commit the task**

```bash
git add AGENTS.md docs/development/gcloud-robot.md scripts/vitest-cloud.sh scripts/e2e-cloud.sh scripts/test/cloud-gcp-identity.test.sh
git commit -m "docs(cloud): recommend GCLOUD_ROBOT_REQUIRE for agent gates; document well-known-path discovery and fail-fast identity (kata e83z)"
```

---

## Verification (whole change)

1. All bash cloud suites green: `for s in scripts/test/cloud-*.test.sh scripts/test/e2e-harness-timeout-env.test.sh; do bash "$s" || exit 1; done` (requires the Pre-step 0 repair and a warmed `target/` for the W7-nested cloud-run-wrapper leg; the first cold run is slow, subsequent runs fast).
2. Tier 1 — resolve-level discovery smoke (REQUIRED; ~10s; free; read-only; no coordinator gate — it is not a lane run). From the worktree, this exercises the real well-known discovery, the real selector + IAM probe, the source attribution, and the preflight mint:

```bash
env -u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_ACCOUNT \
    -u FRESHELL_GCP_ACCOUNT -u GCLOUD_IDENT_RESOLVED \
    -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT \
    GCLOUD_ROBOT_REQUIRE=1 \
  bash -c 'set -euo pipefail
    . scripts/lib/gcp-identity.sh
    GCP_PROJECT="misc-puttering-project"
    GCP_ACCOUNT=""
    freshell_resolve_cloud_identity "run.jobs.run"
    echo "IDENT=${GCLOUD_IDENT:?}"
    echo "SOURCE=${FRESHELL_GCP_IDENTITY_SOURCE:?}"
    gcloud auth print-access-token --account="$GCLOUD_IDENT" >/dev/null
    echo "PREFLIGHT=ok"'
```

Expected: `IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`, `SOURCE=gcloud-robot probe (well-known install: /home/dan/.codex/skills/gcloud-robot)`, `PREFLIGHT=ok` (live-validated equivalent observations 2026-09-21).

3. Tier 2 — integrated narrowed cloud-lane smoke (execution-stage, once at final HEAD before the delta review; coordinator-permitted narrowed lane — explicit filter + 1 shard, not a broad gate). From the clean, committed worktree HEAD (clean tree keeps the image tag content-addressed and reusable by the full-suite gate):

```bash
env -u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_ACCOUNT \
    -u FRESHELL_GCP_ACCOUNT -u GCLOUD_IDENT_RESOLVED \
    -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT \
    GCLOUD_ROBOT_REQUIRE=1 \
  scripts/vitest-cloud.sh run --cloud --config=default --shards=1 \
    test/unit/lib/pane-utils.test.ts
```

Assert: stdout contains `[vitest-cloud] Identity: gcloud-robot@misc-puttering-project.iam.gserviceaccount.com (source: gcloud-robot probe (well-known install: /home/dan/.codex/skills/gcloud-robot))`; stderr contains no `gcloud-robot:` diagnostic; exit 0. (~$0.02, ~2-3 min job + possible first ~13 min image build at the branch commit, shared by any later cloud run of the same commit. `GCLOUD_ROBOT_REQUIRE=1` only alters the failure path — the success path proves the default resolution.)

4. Full-suite coordinated gate at final HEAD per the-usual executing-plans (`npm test` from the worktree, via the repo's coordinator). Coverage honesty: in the agent-harness env (backend vars unset) it validates the local suites only; where `FRESHELL_VITEST_BACKEND=cloud` is inherited the cloud lane runs but at rung 2 (`GCLOUD_IDENT` pinned by the operator bashrc) — it exercises the preflight, never discovery. Discovery against the real install is proven by the Tier 1 and Tier 2 smokes above, not by the gate.
5. No TypeScript/Rust/React surface touched: the pre-push gate passes trivially (its changed-file filters match none of this change set).

## Notes

- Live-incident evidence for this kata ran during this run's workspace stage: another agent's base-gate `gcloud builds submit` parked 3h05m on gcloud's interactive reauth prompt (Freshell PTY, ambient human credential in the reauth-required state, `GCLOUD_ROBOT_HOME` never set in the agent environment) — the exact failure mode Task 1 + Task 2 remove for non-TTY invocations, and Task 1 removes for standard-install machines. The load-bearing stage reproduced the prompt class live (timeout-bounded) and confirmed: non-TTY mint of a reauth-required credential fails in ~1s with the documented error string; TTY mint blocks on the interactive prompt.
- Residual, stated honestly (live-verified, not hypothetical): an agent lane launched under a real PTY (a Freshell terminal pane) with a reauth-required human credential WILL block indefinitely on gcloud's interactive reauth prompt (`Reauthentication required.` / `Please enter your password:`) — prompts are disabled only on non-TTY stdin by design (humans keep interactive reauth). Post-change, discovery moves that blockage EARLIER (inside the resolve, before any banner output) and QUIETER (the selector's stderr and the preflight's output are both redirected): the selector probes `gcloud config get-value account` (the human) before the robot. The documented no-hang lever for PTY agent lanes is pinning `GCLOUD_ROBOT_ACCOUNT` (the selector probes the env-pinned account first and never mints the human) or `GCLOUD_IDENT` — the AGENTS.md bullet and the runbook troubleshooting entry added by Task 4 say so. The malformed-token ("plain invalid_grant") subclass never prompts at all — live-proven in both TTY and non-TTY legs.
- Human-first candidate order (documented, with its guarantee lever): if a LIVE human credential holds the lane's probe permission, the selector legitimately selects the human over the robot (candidate order: `GCLOUD_ROBOT_ACCOUNT` > config account > auth list — the skill's own policy; on the target project today the human lacks lane permissions per the operator's own bashrc note, and the live human credential is reauth-dead, so the robot wins in every observed configuration). `GCLOUD_ROBOT_REQUIRE=1` does not close this gap; `GCLOUD_ROBOT_ACCOUNT=<robot>` is the only lever that guarantees robot-first, and Task 4's AGENTS.md bullet documents it as such. Discovery makes the robot reachable and the banner reports what actually got picked; state the residual plainly in the PR description.
- Broker interplay (garageserver): the OneCLI gateway brokers control-plane hosts only; `oauth2.googleapis.com` (the preflight's mint) is deliberately unbrokered. Today the robot key is live locally and discovery routes agent lanes to it, so no false-fail; a machine with NO usable local identity that previously sailed through brokered hosts now fails fast at the preflight instead (arguably correct — the identity really is broken). Task 4's runbook broker note documents this.
- The kata's target population is exactly the non-bashrc shells (agent harnesses, server-spawned panes): every bashrc-sourcing shell already gets `GCLOUD_IDENT` pinned pre-guard and never reaches discovery. Say so in the PR description.
- The skill's canonical SKILL.md (`~/code/skill-gcloud-robot`) says `GCLOUD_ROBOT_HOME` is the only sanctioned resolution; this change knowingly diverges per the user's kata (the skill's own override rule sanctions it). The Freshell-side header rewrite records the divergence; the skill repo itself is out of scope — mention it in the PR description.
- Pre-existing red repaired by Task 1 Pre-step 0: `cloud-exec-id-parse.test.sh` (harness drift — fake gcloud missing the `logging read` stub the e2e wrapper's receipts reconciliation requires; verified red at the base commit in this worktree and green after the stub). Recorded here so reviewers don't mistake the repair for test-weakening.
