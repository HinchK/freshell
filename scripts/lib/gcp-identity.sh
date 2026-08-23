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
