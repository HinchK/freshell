#!/usr/bin/env bash
# verify-remote-access.sh — live end-to-end verification of the Freshell Rust
# server's remote-access networking (owning plan:
# docs/plans/2026-08-03-remote-access-networking.md).
#
# Usage:
#   scripts/verify-remote-access.sh [--port N] [--tier-c] [--keep-home] [--verbose]
#
# Default port = an ephemeral free high port (probed, never hardcoded).
# --tier-c is honored ONLY with --port 3001 and only if nothing listens there.
#
# Exit codes:
#   0  all required checks passed (tier-c may be degraded-with-reason)
#   1  a required check failed (incl. tier-b failure, or host-state changed)
#   2  usage error
#   3  preflight precondition failed (missing binary, missing eth0 IP, etc.)
#
# SAFETY: never binds or kills port 3001 / the live server (pid holding 0.0.0.0:3001).
# Only READ-ONLY `netsh ... show` is used. Never creates/modifies portproxy or
# firewall rules. Reaps only pids it started, ownership-verified via /proc/<pid>.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=""; TIER_C=0; KEEP_HOME=0; VERBOSE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --tier-c) TIER_C=1; shift ;;
    --keep-home) KEEP_HOME=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    *) echo "usage: $0 [--port N] [--tier-c] [--keep-home] [--verbose]"; exit 2 ;;
  esac
done
REPORT_DIR="$(mktemp -d "/tmp/freshell-verify-remote-access-$$-XXXX")"
SERVER_PID=""; HOME_DIR=""
declare -a DEGRADATIONS=()
REQUIRED_FAIL=0

log() { [ "$VERBOSE" = 1 ] && echo "[vra] $*" >&2 || true; }
fail_required() { echo "REQUIRED FAIL: $*" >&2; REQUIRED_FAIL=1; }

cleanup() { :; }  # replaced in Task 5.5
trap cleanup EXIT INT TERM

probe_free_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

phase0_preflight() {
  [ -n "$PORT" ] || PORT="$(probe_free_port)"
  # binary present, else build
  if [ ! -x "$REPO_ROOT/target/release/freshell-server" ]; then
    ( cd "$REPO_ROOT" && cargo build --release -p freshell-server ) || { echo "FATAL: build failed"; exit 3; }
  fi
  # eth0 IP re-resolved EVERY run; empty => tier b unavailable => hard fail
  WSL_IP="$(ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+' || true)"
  [ -n "$WSL_IP" ] || { echo "FATAL: no eth0 IPv4 (tier b unavailable)"; exit 3; }
  powershell.exe -NoProfile -Command "echo ok" >/dev/null 2>&1 || { echo "FATAL: powershell.exe unavailable (tier b)"; exit 3; }
  # refuse to touch a listening port (esp. the live server / 3001)
  if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT "; then
    echo "FATAL: something already listens on :$PORT — refusing"; exit 3
  fi
  if [ "$PORT" = "3001" ] && [ "$TIER_C" != 1 ]; then
    echo "FATAL: refusing to use 3001 without --tier-c"; exit 3
  fi
  # isolated HOME with a full-sentinel config.json; sha256 per top-level key
  HOME_DIR="$(mktemp -d)"; mkdir -p "$HOME_DIR/.freshell"
  cat > "$HOME_DIR/.freshell/config.json" <<'JSON'
{ "version": 1,
  "settings": { "network": { "host": "127.0.0.1", "configured": true } },
  "sessionOverrides": { "SENTINEL_SESSION": { "keep": "me" } },
  "terminalOverrides": { "SENTINEL_TERM": { "keep": "me" } },
  "serverSecrets": { "SENTINEL_SECRET": "do-not-touch" },
  "completedMigrations": ["m-001"],
  "recentDirectories": ["/tmp/a"],
  "projectColors": { "/tmp/a": "#123456" },
  "someUnknownFutureKey": { "arbitrary": [1, 2, 3] } }
JSON
  # configured:true is deliberate: without it a WSL boot defaults to 0.0.0.0
  # (VALIDATED, ledger A-04/A-05). Boot must honor the persisted loopback intent
  # (Tasks 0.3 + 2.2b). NEVER set FRESHELL_BIND_HOST anywhere in this harness -
  # it outranks config and would mask exactly what Phase 5 exists to prove.
  AUTH_TOKEN="$(openssl rand -hex 32)"  # never echoed/written to the report
  # per-key sha of the ORIGINAL for the Phase-5 diff (exclude version/settings)
  for k in sessionOverrides terminalOverrides serverSecrets completedMigrations recentDirectories projectColors someUnknownFutureKey; do
    eval "SHA_$k=\"$(jq -c ".$k" "$HOME_DIR/.freshell/config.json" | sha256sum | cut -d' ' -f1)\""
  done
  # read-only host network state for the Phase-7 identity diff — BOTH halves:
  # the portproxy table AND the FreshellLANAccess firewall rule (Phase 7 diffs each)
  HOST_STATE_BEFORE="$(powershell.exe -NoProfile -Command 'netsh interface portproxy show all' 2>/dev/null || true)"
  FIREWALL_STATE_BEFORE="$(powershell.exe -NoProfile -Command 'netsh advfirewall firewall show rule name=FreshellLANAccess' 2>/dev/null || true)"
}

phase1_boot() {
  HOME="$HOME_DIR" FRESHELL_HOME="$HOME_DIR" AUTH_TOKEN="$AUTH_TOKEN" PORT="$PORT" \
    FRESHELL_DISABLE_WSL_PORT_FORWARD=1 \
    "$REPO_ROOT/target/release/freshell-server" >"$HOME_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$REPORT_DIR/server.pid"
  for _ in $(seq 1 100); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)" = "200" ]; then
      # Boot must honor the seeded configured loopback (Tasks 0.3 + 2.2b).
      ss -ltn | grep ":$PORT " | grep -q '127.0.0.1' \
        || { echo "FATAL: boot bound non-loopback despite configured:true"; exit 1; }
      return 0
    fi
    sleep 0.2
  done
  echo "FATAL: server did not become healthy"; exit 1
}

main() {
  phase0_preflight
  phase1_boot
  # Phases 2-7 appended in Tasks 5.2-5.5
  echo "phase0+1 OK (port=$PORT wsl_ip=$WSL_IP)"
}
main "$@"
