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
# permitted copy. Run-time discovery of the selector happens via an
# explicitly set GCLOUD_ROBOT_HOME or — when that is unset — via the
# Freshell bridge's well-known-path probe (freshell_discover_robot_home),
# in order: ~/.codex/skills/gcloud-robot, ~/.claude/skills/gcloud-robot,
# ~/code/skill-gcloud-robot/gcloud-robot. The bridge pre-fills
# GCLOUD_ROBOT_HOME from that probe BEFORE the untouched ladder runs.
#
# Ladder (fixed order):
#   1. A call-site / repo pin (the wrapper's --account= or FRESHELL_GCP_ACCOUNT)
#      is never overridden — the bridge below only fills an EMPTY pin var.
#   2. GCLOUD_IDENT set: use verbatim, no probe, no network.
#   3. Probe: $GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh picks a
#      credentialed account that passes the lane's live permission probe.
#      The Freshell bridge defaults GCLOUD_ROBOT_HOME from the well-known
#      install locations before this rung runs (see
#      freshell_discover_robot_home).
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
