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

PASS=0; FAIL=0
check() { # check DESC CMD...  -> pass/fail counters; every Phase 2-4 assertion is required
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS+1)); log "PASS: $desc"
  else FAIL=$((FAIL+1)); fail_required "$desc"; fi
}

api() { # api METHOD PATH [BODY] [--noauth]  -> echoes "HTTP_CODE\n BODY"
  local method="$1" path="$2" body="${3:-}" auth=(-H "x-auth-token: $AUTH_TOKEN")
  [ "${4:-}" = "--noauth" ] && auth=()
  curl -s -o "$REPORT_DIR/resp.json" -w '%{http_code}' -X "$method" \
    "${auth[@]}" -H 'content-type: application/json' \
    ${body:+--data "$body"} "http://127.0.0.1:$PORT$path"
}
tier_b() { # returns "200" (reachable => 0.0.0.0-bound) or "REFUSED"
  powershell.exe -NoProfile -Command \
    "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 http://$WSL_IP:$PORT/api/health).StatusCode } catch { 'REFUSED' }" \
    2>/dev/null | tr -d '\r'
}
tier_c_probe() { # LAN vantage via lanIps[0]; meaningful only at :3001 (the portproxy chain is 3001-scoped)
  powershell.exe -NoProfile -Command \
    "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 http://$1:$PORT/api/health).StatusCode } catch { 'REFUSED' }" \
    2>/dev/null | tr -d '\r'
}

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

# Phase 2 - endpoint surface (auth +/-): each of the five endpoints once WITH
# auth (200; POSTs get a valid body) and once WITHOUT (401 {"error":"Unauthorized"}).
# The authed POST bodies here are deliberate no-ops on the loopback boot state
# (configure re-asserts loopback; disable/configure-firewall resolve to
# method:"none" while nothing is exposed) - the REAL expose is Phase 3's job.
phase2_endpoint_surface() {
  local code ct
  # GET /api/network/status
  code="$(api GET /api/network/status)" || code=ERR
  check "phase2: status authed -> 200" [ "$code" = "200" ]
  check "phase2: status has EVERY NetworkStatus key with correct type (portOpen: presence)" \
    jq -e '(.configured|type=="boolean") and (.host|type=="string")
       and (.remoteAccessEnabled|type=="boolean") and (.remoteAccessRequested|type=="boolean")
       and (.remoteAccessNeedsRepair|type=="boolean") and (.port|type=="number")
       and (.lanIps|type=="array") and (.machineHostname|type=="string")
       and (.firewall|type=="object") and (.firewall.platform|type=="string")
       and (.firewall.active|type=="boolean") and (.firewall|has("portOpen"))
       and (.firewall.commands|type=="array") and (.firewall.configuring|type=="boolean")
       and (.rebinding|type=="boolean") and (.devMode|type=="boolean")
       and (.accessUrl|type=="string")' "$REPORT_DIR/resp.json"
  # content-type on the LIVE wire is exactly `application/json; charset=utf-8`:
  # main.rs's global `ensure_json_charset` layer (main.rs:1552-1572, applied at
  # :1362) rewrites axum Json's bare `application/json` for Express res.json
  # byte-parity. (The Slice-1 in-crate test, network.rs:3788, pins the bare
  # form because it oneshots the sub-router WITHOUT that layer.)
  ct="$(curl -s -o /dev/null -w '%{content_type}' -H "x-auth-token: $AUTH_TOKEN" \
    "http://127.0.0.1:$PORT/api/network/status" || true)"
  check "phase2: status content-type exactly application/json; charset=utf-8" \
    [ "$ct" = "application/json; charset=utf-8" ]
  code="$(api GET /api/network/status '' --noauth)" || code=ERR
  check "phase2: status unauthed -> 401" [ "$code" = "401" ]
  check "phase2: status unauthed body Unauthorized" jq -e '.error == "Unauthorized"' "$REPORT_DIR/resp.json"
  # GET /api/lan-info
  code="$(api GET /api/lan-info)" || code=ERR
  check "phase2: lan-info authed -> 200" [ "$code" = "200" ]
  code="$(api GET /api/lan-info '' --noauth)" || code=ERR
  check "phase2: lan-info unauthed -> 401" [ "$code" = "401" ]
  check "phase2: lan-info unauthed body Unauthorized" jq -e '.error == "Unauthorized"' "$REPORT_DIR/resp.json"
  # POST /api/network/configure (loopback no-op body)
  code="$(api POST /api/network/configure '{"host":"127.0.0.1","configured":true}')" || code=ERR
  check "phase2: configure authed (loopback no-op) -> 200" [ "$code" = "200" ]
  code="$(api POST /api/network/configure '{"host":"127.0.0.1","configured":true}' --noauth)" || code=ERR
  check "phase2: configure unauthed -> 401" [ "$code" = "401" ]
  check "phase2: configure unauthed body Unauthorized" jq -e '.error == "Unauthorized"' "$REPORT_DIR/resp.json"
  # POST /api/network/disable-remote-access ({} valid: schema fields optional)
  code="$(api POST /api/network/disable-remote-access '{}')" || code=ERR
  check "phase2: disable-remote-access authed -> 200" [ "$code" = "200" ]
  code="$(api POST /api/network/disable-remote-access '{}' --noauth)" || code=ERR
  check "phase2: disable-remote-access unauthed -> 401" [ "$code" = "401" ]
  check "phase2: disable-remote-access unauthed body Unauthorized" jq -e '.error == "Unauthorized"' "$REPORT_DIR/resp.json"
  # POST /api/network/configure-firewall ({} valid; loopback => method:none, NO OS call)
  code="$(api POST /api/network/configure-firewall '{}')" || code=ERR
  check "phase2: configure-firewall authed -> 200" [ "$code" = "200" ]
  code="$(api POST /api/network/configure-firewall '{}' --noauth)" || code=ERR
  check "phase2: configure-firewall unauthed -> 401" [ "$code" = "401" ]
  check "phase2: configure-firewall unauthed body Unauthorized" jq -e '.error == "Unauthorized"' "$REPORT_DIR/resp.json"
  echo "phase2 endpoint surface: pass=$PASS fail=$FAIL"
}

# Phase 3 - live EXPOSE: configure 0.0.0.0, then prove exposure via the vantage
# ladder. Exposure ground truth is the ladder, NOT portOpen/remoteAccessEnabled:
# at non-3001 ports the wsl2 probe targets lanIps[0] (Windows LAN IP, reachable
# only through the 3001-scoped portproxy) => portOpen null => remoteAccessEnabled
# false (VALIDATED, ledger A-05, reports/V3.md). Status calls on a wildcard bind
# cost ~2-3s (uncached probe timeout).
phase3_expose() {
  local code tier_a tb tier_c_result lan_ip
  code="$(api POST /api/network/configure '{"host":"0.0.0.0","configured":true}')" || code=ERR
  check "phase3: configure 0.0.0.0 -> 200" [ "$code" = "200" ]
  check "phase3: response host==0.0.0.0, configured==true, rebindScheduled==false" \
    jq -e '.host=="0.0.0.0" and .configured==true and .rebindScheduled==false' "$REPORT_DIR/resp.json"
  check "phase3: portOpen==null and remoteAccessEnabled==false (non-3001 ledger truth)" \
    jq -e '.firewall.portOpen==null and .remoteAccessEnabled==false' "$REPORT_DIR/resp.json"
  lan_ip="$(jq -r '.lanIps[0] // empty' "$REPORT_DIR/resp.json")"
  tier_a="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)"
  check "phase3: tier (a) loopback /api/health -> 200" [ "$tier_a" = "200" ]
  tb="$(tier_b)"
  check "phase3: tier (b) Windows-host reach -> 200 [REQUIRED]" [ "$tb" = "200" ]
  if [ "$TIER_C" = 1 ] && [ "$PORT" = "3001" ]; then
    if [ -n "$lan_ip" ] && [ "$(tier_c_probe "$lan_ip")" = "200" ]; then
      PASS=$((PASS+1)); tier_c_result=200
    else
      DEGRADATIONS+=("tier-c: lanIps[0]=$lan_ip unreachable at :$PORT from the Windows host")
      tier_c_result=degraded
    fi
  else
    DEGRADATIONS+=("tier-c: skipped - PORT=$PORT != 3001 (the portproxy chain is 3001-scoped; rerun --port 3001 --tier-c when 3001 is free)")
    tier_c_result=skipped
  fi
  echo "phase3 expose: tier_a=$tier_a tier_b=$tb tier_c=$tier_c_result"
}

# Phase 4 - live RETRACT: disable-remote-access, then prove retraction. The
# disable response is emitted only after the old listener is provably closed
# (Task 2.1 barrier) => checks may run immediately; tier (b) still gets ONE
# retry after 2s (powershell.exe flakiness, not drain).
phase4_retract() {
  local code tier_a tb nlisten bound
  code="$(api POST /api/network/disable-remote-access '{}')" || code=ERR
  check "phase4: disable-remote-access -> 200" [ "$code" = "200" ]
  check "phase4: response carries method" jq -e 'has("method")' "$REPORT_DIR/resp.json"
  code="$(api GET /api/network/status)" || code=ERR
  check "phase4: status -> 200" [ "$code" = "200" ]
  check "phase4: host==127.0.0.1, portOpen==null, remoteAccessEnabled==false" \
    jq -e '.host=="127.0.0.1" and .firewall.portOpen==null and .remoteAccessEnabled==false' "$REPORT_DIR/resp.json"
  tb="$(tier_b)"
  if [ "$tb" != "REFUSED" ]; then sleep 2; tb="$(tier_b)"; fi
  check "phase4: tier (b) connection REFUSED [REQUIRED]" [ "$tb" = "REFUSED" ]
  tier_a="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)"
  check "phase4: tier (a) loopback still 200" [ "$tier_a" = "200" ]
  nlisten="$(ss -ltn | grep -c ":$PORT " || true)"
  check "phase4: exactly ONE listener on :$PORT" [ "$nlisten" = "1" ]
  bound="$(ss -ltn | grep ":$PORT " | awk '{print $4}' | head -1 || true)"
  check "phase4: listener bound 127.0.0.1" [ "$bound" = "127.0.0.1:$PORT" ]
  echo "phase4 retract: tier_a=$tier_a tier_b=$tb listeners=$nlisten bound=$bound"
}

main() {
  phase0_preflight
  phase1_boot
  phase2_endpoint_surface
  phase3_expose
  phase4_retract
  # Phases 5-7 appended in Tasks 5.3-5.5
  if [ "${#DEGRADATIONS[@]}" -gt 0 ]; then printf 'DEGRADED: %s\n' "${DEGRADATIONS[@]}"; fi
  echo "phases 0-4: pass=$PASS fail=$FAIL required_fail=$REQUIRED_FAIL (port=$PORT wsl_ip=$WSL_IP)"
  [ "$REQUIRED_FAIL" = 0 ] || exit 1
}
main "$@"
