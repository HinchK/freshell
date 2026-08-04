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
tier_b() { # "200" (reachable => 0.0.0.0-bound) | "REFUSED" (actively refused)
  # | "TIMEOUT" | "ERROR". Refined per Task 5.2 review: the old blanket
  # catch => 'REFUSED' conflated timeout/DNS/any exception with
  # connection-refused. Callers pass ONLY on the exact expected value, so
  # TIMEOUT/ERROR fail closed instead of masquerading as a verified
  # retraction. Refused is detected by walking the exception chain for a
  # SocketException with SocketErrorCode ConnectionRefused
  # (locale-independent), with a message match as fallback.
  local ps
  ps="try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 http://$WSL_IP:$PORT/api/health).StatusCode } catch { \$e = \$_.Exception; \$refused = \$false; \$msgs = ''; while (\$e) { \$msgs += ' ' + \$e.Message; if (\$e -is [System.Net.Sockets.SocketException] -and \$e.SocketErrorCode -eq 'ConnectionRefused') { \$refused = \$true }; \$e = \$e.InnerException }; if (\$refused -or \$msgs -match 'actively refused|connection refused') { 'REFUSED' } elseif (\$msgs -match 'timed out|timeout') { 'TIMEOUT' } else { 'ERROR' } }"
  powershell.exe -NoProfile -Command "$ps" 2>/dev/null | tr -d '\r'
}
tier_c_probe() { # LAN vantage via lanIps[0]; meaningful only at :3001 (the portproxy chain is 3001-scoped)
  powershell.exe -NoProfile -Command \
    "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 http://$1:$PORT/api/health).StatusCode } catch { 'REFUSED' }" \
    2>/dev/null | tr -d '\r'
}

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # ownership verify before signaling
    local cwd cmd
    cwd="$(readlink -f /proc/$SERVER_PID/cwd 2>/dev/null || true)"
    cmd="$(tr '\0' ' ' < /proc/$SERVER_PID/cmdline 2>/dev/null || true)"
    # Never signal a pid we don't own: cmdline must be our server AND the pid
    # must NOT hold :3001 (the user's live instance). No hardcoded pids.
    if echo "$cmd" | grep -q 'freshell-server' \
       && ! ss -ltnp 2>/dev/null | grep ":3001 " | grep -q "pid=$SERVER_PID,"; then
      kill -TERM "$SERVER_PID" 2>/dev/null || true
      for _ in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.2; done
    fi
  fi
  [ "$KEEP_HOME" = 1 ] || { [ -n "${HOME_DIR:-}" ] && rm -rf "$HOME_DIR"; }
}
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
  "serverSecrets": { "SENTINEL_SECRET": "do-not-touch",
                     "codexDisplayIdSecret": "constant-sentinel-secret-value" },
  "completedMigrations": ["m-001"],
  "recentDirectories": ["/tmp/a"],
  "projectColors": { "/tmp/a": "#123456" },
  "someUnknownFutureKey": { "arbitrary": [1, 2, 3] } }
JSON
  # codexDisplayIdSecret is seeded so serverSecrets survives byte-for-byte:
  # boot MINTS one when absent (upstream parity, config-store.ts:443-452;
  # settings_store.rs:1295-1311 reuses a seeded value verbatim). Without the
  # seed, Phase 5's NET-09 diff flags a boot-time write that is NOT a network
  # mutation. Same approach as the in-crate NET-09 test
  # (net09_config_preservation.rs:80). Caught live by this harness (RED run).
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
  TIER_C_PROBE="$tier_c_result"  # consumed by Phase 7's tier-c gating
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

# Phase 5 - RESTART / NET-09 byte-preservation: ownership-verified SIGTERM of
# the owned server, then a per-key sha256 diff of config.json (NET-09: after
# the Phase 3/4 mutations, settings.network reflects the chosen state and
# EVERY other top-level key is byte-identical to the Phase-0 original), then
# a restart on the same isolated HOME with the SAME env as Phase 1 - in
# particular FRESHELL_DISABLE_WSL_PORT_FORWARD=1 and still no
# FRESHELL_BIND_HOST (a bare restart silently changes lanes - reports/V5.md).
# Post-restart, status must show the persisted state (host=="127.0.0.1") and
# tier (b) must be REFUSED. Live proof of Tasks 0.3 + 2.2b (ledger A-04).
phase5_restart() {
  local k now orig net09 code tb tier_a cmdline cwd pid3001 i
  # -- ownership verification BEFORE any signal (never blind, never :3001) --
  pid3001="$(ss -ltnp "( sport = :3001 )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "$pid3001" ] && [ "$SERVER_PID" = "$pid3001" ]; then
    fail_required "phase5: SERVER_PID=$SERVER_PID holds :3001 - refusing to signal"; return 0
  fi
  cmdline="$(tr '\0' ' ' < "/proc/$SERVER_PID/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    "$REPO_ROOT/target/release/freshell-server"*) : ;;
    *) fail_required "phase5: /proc/$SERVER_PID/cmdline ('$cmdline') is not our spawned binary - refusing to signal"; return 0 ;;
  esac
  cwd="$(readlink "/proc/$SERVER_PID/cwd" 2>/dev/null || true)"
  if [ "$cwd" != "$PWD" ]; then
    fail_required "phase5: /proc/$SERVER_PID/cwd ('$cwd') != harness cwd ('$PWD') - refusing to signal"; return 0
  fi
  # -- SIGTERM + bounded wait (10s); NEVER escalates to SIGKILL --
  kill -TERM "$SERVER_PID" 2>/dev/null || { fail_required "phase5: SIGTERM failed (pid $SERVER_PID already gone?)"; return 0; }
  for i in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    fail_required "phase5: server $SERVER_PID still alive 10s after SIGTERM (not escalating to SIGKILL)"; return 0
  fi
  wait "$SERVER_PID" 2>/dev/null || true  # reap our own child
  if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT "; then
    fail_required "phase5: :$PORT still has a listener after server exit"
  else PASS=$((PASS+1)); log "PASS: phase5: :$PORT released after SIGTERM"; fi
  # -- NET-09 diff: settings.network reflects the chosen (retracted) state --
  check "phase5: persisted settings.network == {host:127.0.0.1, configured:true}" \
    jq -e '.settings.network.host=="127.0.0.1" and .settings.network.configured==true' \
    "$HOME_DIR/.freshell/config.json"
  # -- NET-09 diff: every other top-level key byte-identical (sha vs Phase 0) --
  net09=intact
  for k in sessionOverrides terminalOverrides serverSecrets completedMigrations recentDirectories projectColors someUnknownFutureKey; do
    now="$(jq -c ".$k" "$HOME_DIR/.freshell/config.json" | sha256sum | cut -d' ' -f1)"
    eval "orig=\$SHA_$k"
    [ "$now" = "$orig" ] || { fail_required "top-level key $k changed across mutation"; net09=VIOLATED; }
  done
  # -- restart on the same isolated HOME with the SAME env as Phase 1, by
  # calling phase1_boot itself (env identical by construction:
  # FRESHELL_DISABLE_WSL_PORT_FORWARD=1, no FRESHELL_BIND_HOST). It also
  # re-runs the health wait + loopback-bind assertion: a restart that came up
  # on 0.0.0.0 dies there with FATAL (that would falsify Tasks 0.3/2.2b). --
  phase1_boot
  code="$(api GET /api/network/status)" || code=ERR
  check "phase5: post-restart status -> 200" [ "$code" = "200" ]
  check "phase5: post-restart host==127.0.0.1 && configured==true (persisted state honored)" \
    jq -e '.host=="127.0.0.1" and .configured==true' "$REPORT_DIR/resp.json"
  tier_a="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)"
  check "phase5: post-restart tier (a) loopback -> 200" [ "$tier_a" = "200" ]
  tb="$(tier_b)"
  if [ "$tb" != "REFUSED" ]; then sleep 2; tb="$(tier_b)"; fi
  check "phase5: post-restart tier (b) connection REFUSED [REQUIRED]" [ "$tb" = "REFUSED" ]
  echo "phase5 restart: sigterm=ok net09=$net09 new_pid=$SERVER_PID tier_a=$tier_a tier_b=$tb"
}

# Phase 6 - NET-08 negative security matrix (15 cases): every case asserts the
# expected status/body AND zero side effects - config.json byte-identical
# (full-file sha256) and the `ss` listener set unchanged vs the Phase-6
# baseline. The token PROTOCOL cases (replay / wrong-action / parallel 409)
# are Rust-only by VALIDATED necessity (ledger A-06, reports/V5.md: with
# FRESHELL_DISABLE_WSL_PORT_FORWARD=1 on this host no live lane ever issues a
# confirmation token) - covered by the Task 3.5 unit tests, NOT here. Cases
# 5/6/14 are ALSO proved structurally in Rust (`host` enum, `wsl_ip: Ipv4Addr`,
# FakeCommandRunner::call_count()==0); the harness proves them live too - both
# required, neither substitutes for the other. Injection-string bodies below
# are single-quoted so bash/jq NEVER interpret them - they exist to prove the
# SERVER rejects/neutralizes them.
config_sha() { sha256sum "$HOME_DIR/.freshell/config.json" | cut -d' ' -f1; }
listener_set() { { ss -ltn | grep ":$PORT " || true; } | awk '{print $4}' | sort | paste -sd, -; }
NET08_SHA=""; NET08_LSET=""
net08_intact() { # CASE-DESC -> zero-side-effect assertion vs the Phase-6 baseline
  local desc="$1"
  check "phase6: $desc - config.json byte-identical" [ "$(config_sha)" = "$NET08_SHA" ]
  check "phase6: $desc - listener set unchanged" [ "$(listener_set)" = "$NET08_LSET" ]
}
reject400() { # DESC PATH BODY -> 400 {"error":"Invalid request"} + zero side effects
  local desc="$1" path="$2" body="$3" code
  code="$(api POST "$path" "$body")" || code=ERR
  check "phase6: $desc -> 400" [ "$code" = "400" ]
  check "phase6: $desc body Invalid request" jq -e '.error=="Invalid request"' "$REPORT_DIR/resp.json"
  net08_intact "$desc"
}
benign200() { # DESC PATH BODY -> 200 method:"none" + zero side effects
  local desc="$1" path="$2" body="$3" code
  code="$(api POST "$path" "$body")" || code=ERR
  check "phase6: $desc -> 200" [ "$code" = "200" ]
  check "phase6: $desc method none" jq -e '.method=="none"' "$REPORT_DIR/resp.json"
  net08_intact "$desc"
}

phase6_net08_matrix() {
  local code uuid pid_a pid_b c1 c2
  NET08_SHA="$(config_sha)"; NET08_LSET="$(listener_set)"
  # case 1: no token -> 401. The body is a REAL expose attempt - auth must stop it.
  code="$(api POST /api/network/configure '{"host":"0.0.0.0","configured":true}' --noauth)" || code=ERR
  check "phase6: case1 no token -> 401" [ "$code" = "401" ]
  check "phase6: case1 body Unauthorized" jq -e '.error=="Unauthorized"' "$REPORT_DIR/resp.json"
  net08_intact "case1 no-token"
  # case 2: wrong token -> 401
  code="$(curl -s -o "$REPORT_DIR/resp.json" -w '%{http_code}' -X POST \
    -H 'x-auth-token: not-the-real-token' -H 'content-type: application/json' \
    --data '{"host":"0.0.0.0","configured":true}' \
    "http://127.0.0.1:$PORT/api/network/configure")" || code=ERR
  check "phase6: case2 wrong token -> 401" [ "$code" = "401" ]
  check "phase6: case2 body Unauthorized" jq -e '.error=="Unauthorized"' "$REPORT_DIR/resp.json"
  net08_intact "case2 wrong-token"
  # case 3: empty / missing-field configure bodies -> 400 Invalid request
  reject400 "case3a configure {}"                 /api/network/configure '{}'
  reject400 "case3b configure missing host"       /api/network/configure '{"configured":true}'
  reject400 "case3c configure missing configured" /api/network/configure '{"host":"0.0.0.0"}'
  # case 4: arbitrary host -> 400 (NetworkHost enum: only 127.0.0.1 / 0.0.0.0)
  reject400 "case4 host 1.2.3.4" /api/network/configure '{"host":"1.2.3.4","configured":true}'
  # case 5: command-injection host -> 400
  reject400 "case5 host semicolon-rm" /api/network/configure '{"host":"0.0.0.0; rm -rf /","configured":true}'
  # case 6: injection variants in host -> 400 each
  reject400 "case6a host dollar-paren" /api/network/configure '{"host":"$(id)","configured":true}'
  reject400 "case6b host backtick"     /api/network/configure '{"host":"`id`","configured":true}'
  reject400 "case6c host pipe"         /api/network/configure '{"host":"0.0.0.0|id","configured":true}'
  reject400 "case6d host newline"      /api/network/configure '{"host":"0.0.0.0\nid","configured":true}'
  # case 7: configured wrong type -> 400
  reject400 "case7 configured string" /api/network/configure '{"host":"0.0.0.0","configured":"yes"}'
  # case 8: strict schema - unknown key on disable-remote-access -> 400
  reject400 "case8 disable unknownKey" /api/network/disable-remote-access '{"unknownKey":1}'
  # case 9: confirmElevation:false -> 400 (zod literal true)
  reject400 "case9 confirmElevation false" /api/network/configure-firewall '{"confirmElevation":false}'
  # case 10: empty confirmationToken -> 400 (min length 1)
  reject400 "case10 empty confirmationToken" /api/network/configure-firewall '{"confirmationToken":""}'
  # case 11: token-shaped configure-firewall -> benign 200 method:"none".
  # VALIDATED (ledger A-06): no live lane on this host ever ISSUES a token, so
  # any presented token is inert; replay/wrong-action/parallel-409 live in Rust.
  uuid="$(cat /proc/sys/kernel/random/uuid)"
  benign200 "case11 fw uuid token" /api/network/configure-firewall "{\"confirmationToken\":\"$uuid\"}"
  # case 12: same token shape against disable-remote-access -> 200 method:"none"
  benign200 "case12 disable uuid token" /api/network/disable-remote-access "{\"confirmationToken\":\"$uuid\"}"
  # case 13: two PARALLEL disable POSTs -> both 200 method:"none"; the
  # net_mutation lock serializes them (no live 409 expected - Rust-tested).
  curl -s -o "$REPORT_DIR/par1.json" -w '%{http_code}' -X POST \
    -H "x-auth-token: $AUTH_TOKEN" -H 'content-type: application/json' --data '{}' \
    "http://127.0.0.1:$PORT/api/network/disable-remote-access" >"$REPORT_DIR/par1.code" &
  pid_a=$!
  curl -s -o "$REPORT_DIR/par2.json" -w '%{http_code}' -X POST \
    -H "x-auth-token: $AUTH_TOKEN" -H 'content-type: application/json' --data '{}' \
    "http://127.0.0.1:$PORT/api/network/disable-remote-access" >"$REPORT_DIR/par2.code" &
  pid_b=$!
  wait "$pid_a"; wait "$pid_b"
  c1="$(cat "$REPORT_DIR/par1.code")"; c2="$(cat "$REPORT_DIR/par2.code")"
  check "phase6: case13 parallel disable A -> 200" [ "$c1" = "200" ]
  check "phase6: case13 parallel disable B -> 200" [ "$c2" = "200" ]
  check "phase6: case13 parallel A method none" jq -e '.method=="none"' "$REPORT_DIR/par1.json"
  check "phase6: case13 parallel B method none" jq -e '.method=="none"' "$REPORT_DIR/par2.json"
  net08_intact "case13 parallel-disables"
  # case 14: injection strings in confirmationToken -> 200 method:"none".
  # Non-empty strings pass shape validation BY DESIGN - the property is
  # behavioral: zero side effects, nothing reaches a runner.
  benign200 "case14a fw token dollar-paren" /api/network/configure-firewall '{"confirmationToken":"$(id)"}'
  benign200 "case14b fw token backtick"     /api/network/configure-firewall '{"confirmationToken":"`id`"}'
  benign200 "case14c fw token newline"      /api/network/configure-firewall '{"confirmationToken":"a\nb"}'
  # case 15: POSITIVE CONTROL - a valid configure still succeeds (the negative
  # results above are rejections, not a dead server) AND the zero-side-effect
  # detectors demonstrably FIRE on a real mutation (meta-falsifier). Then the
  # state is restored to the Phase-6 baseline.
  code="$(api POST /api/network/configure '{"host":"0.0.0.0","configured":true}')" || code=ERR
  check "phase6: case15 positive-control configure 0.0.0.0 -> 200" [ "$code" = "200" ]
  check "phase6: case15 response host==0.0.0.0" jq -e '.host=="0.0.0.0"' "$REPORT_DIR/resp.json"
  check "phase6: case15 detector fires - config sha CHANGED" [ "$(config_sha)" != "$NET08_SHA" ]
  check "phase6: case15 detector fires - listener set CHANGED" [ "$(listener_set)" != "$NET08_LSET" ]
  code="$(api POST /api/network/disable-remote-access '{}')" || code=ERR
  check "phase6: case15 restore disable -> 200" [ "$code" = "200" ]
  check "phase6: case15 restore method none" jq -e '.method=="none"' "$REPORT_DIR/resp.json"
  check "phase6: case15 restore - listener set restored" [ "$(listener_set)" = "$NET08_LSET" ]
  check "phase6: case15 restore - persisted network == loopback/configured" \
    jq -e '.settings.network.host=="127.0.0.1" and .settings.network.configured==true' \
    "$HOME_DIR/.freshell/config.json"
  check "phase6: case15 restore - config sha restored (deterministic serialization)" \
    [ "$(config_sha)" = "$NET08_SHA" ]
  # NET-03 token-never-logged: scan the LOG only - the token legitimately
  # appears in accessUrl response BODIES (reports/V3.md), never in the log.
  if grep -qF -- "$AUTH_TOKEN" "$HOME_DIR/server.log"; then
    fail_required "phase6: AUTH_TOKEN found in server.log (NET-03 token-never-logged)"
  else PASS=$((PASS+1)); log "PASS: phase6: token never logged (NET-03)"; fi
  echo "phase6 net-08 matrix: 15 cases + token-never-logged done (pass=$PASS fail=$FAIL)"
}

# Phase 7 - teardown + no-leak assertion + READ-ONLY host-state identity
# self-proof + tier-c gating + report.json. The self-proof re-runs BOTH
# Phase-0 read-only captures (portproxy table, FreshellLANAccess firewall
# rule) and requires byte-identity: this harness never runs a mutating netsh,
# so ANY diff is a safety violation => HOST_STATE_UNCHANGED=0 + required fail.
phase7_teardown_selfproof_report() {
  local host_after fw_after vantage pp_target
  # -- teardown NOW via the same ownership-verified reaper the EXIT trap uses
  # (idempotent: the trap re-run finds the pid gone), then prove no leak --
  cleanup
  if ss -ltn | grep -q ":$PORT "; then
    fail_required "phase7: listener leaked on :$PORT after cleanup"
  else PASS=$((PASS+1)); log "PASS: phase7: no listener leaked on :$PORT"; fi
  # -- safety self-proof: re-run BOTH read-only captures, diff vs Phase 0 --
  host_after="$(powershell.exe -NoProfile -Command 'netsh interface portproxy show all' 2>/dev/null || true)"
  fw_after="$(powershell.exe -NoProfile -Command 'netsh advfirewall firewall show rule name=FreshellLANAccess' 2>/dev/null || true)"
  HOST_STATE_UNCHANGED=1
  printf '%s\n' "$HOST_STATE_BEFORE"     > "$REPORT_DIR/portproxy.before"
  printf '%s\n' "$host_after"            > "$REPORT_DIR/portproxy.after"
  printf '%s\n' "$FIREWALL_STATE_BEFORE" > "$REPORT_DIR/firewall.before"
  printf '%s\n' "$fw_after"              > "$REPORT_DIR/firewall.after"
  if ! diff -u "$REPORT_DIR/portproxy.before" "$REPORT_DIR/portproxy.after" > "$REPORT_DIR/portproxy.diff"; then
    HOST_STATE_UNCHANGED=0
    fail_required "phase7: host portproxy table CHANGED across run (diff follows)"
    cat "$REPORT_DIR/portproxy.diff" >&2
  fi
  if ! diff -u "$REPORT_DIR/firewall.before" "$REPORT_DIR/firewall.after" > "$REPORT_DIR/firewall.diff"; then
    HOST_STATE_UNCHANGED=0
    fail_required "phase7: FreshellLANAccess firewall rule CHANGED across run (diff follows)"
    cat "$REPORT_DIR/firewall.diff" >&2
  fi
  if [ "$HOST_STATE_UNCHANGED" = 1 ]; then
    PASS=$((PASS+1)); log "PASS: phase7: host state identical (portproxy + FreshellLANAccess rule)"
  fi
  # -- tier-c gating --
  # Unconditional READ-ONLY sanity control from the LAN vantage: curl the
  # USER'S LIVE :3001 health endpoint over ssh. Non-200 / no ssh => the LAN
  # vantage is unavailable today - recorded as a NOTE, never a failure.
  vantage="$(ssh -o BatchMode=yes -o ConnectTimeout=8 shapiroserver2 \
    "curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://192.168.3.50:3001/api/health" \
    2>/dev/null | tr -d '\r' || true)"
  echo "phase7: tier-c vantage control (ssh shapiroserver2 -> live :3001): '${vantage:-}'"
  if [ "$vantage" != "200" ]; then
    echo "NOTE: tier_c_vantage: unavailable (control returned '${vantage:-}'; not a failure)"
  fi
  if [ "$TIER_C" = 1 ] && [ "$PORT" = "3001" ]; then
    TIER_C_STATUS=pass; TIER_C_REASON=""
    pp_target="$(printf '%s\n' "$host_after" | tr -d '\r' | awk '$1=="0.0.0.0" && $2=="3001" {print $3; exit}')"
    if [ "${TIER_C_PROBE:-}" != "200" ]; then
      TIER_C_STATUS=degraded; TIER_C_REASON="phase3 tier-c probe did not return 200 (got '${TIER_C_PROBE:-unset}')"
    elif ss -ltn "( sport = :3001 )" | grep -q ":3001 "; then
      TIER_C_STATUS=degraded; TIER_C_REASON="something still listening on :3001 post-cleanup"
    elif [ -z "$pp_target" ]; then
      TIER_C_STATUS=degraded; TIER_C_REASON="no portproxy rule 0.0.0.0 3001 -> $WSL_IP 3001"
    elif [ "$pp_target" != "$WSL_IP" ]; then
      TIER_C_STATUS=degraded; TIER_C_REASON="portproxy target $pp_target != current eth0 $WSL_IP"
    fi
    if [ "$TIER_C_STATUS" = "degraded" ]; then DEGRADATIONS+=("tier-c: $TIER_C_REASON"); fi
  else
    TIER_C_STATUS=degraded
    TIER_C_REASON="firewall allow scoped to 3001 only (FreshellLANAccess LocalPort=3001); harness port $PORT may not open a new rule (safety rule)"
    DEGRADATIONS+=("$TIER_C_REASON")
  fi
  # -- report.json (tier-c fields via --arg; degradations = the REAL array) --
  jq -n --arg port "$PORT" --arg wsl "$WSL_IP" \
     --arg tcs "$TIER_C_STATUS" --arg tcr "$TIER_C_REASON" \
     --argjson passed "$([ "$REQUIRED_FAIL" = 0 ] && echo true || echo false)" \
     --argjson unchanged "$([ "$HOST_STATE_UNCHANGED" = 1 ] && echo true || echo false)" \
     '{port:($port|tonumber), wsl_ip:$wsl,
       tiers:{a:{},b:{},c:{status:$tcs,reason:$tcr}},
       deferred_host_blocked:["NET-04","NET-05","NET-07"],
       degradations:$ARGS.positional, host_state_unchanged:$unchanged, passed:$passed}' \
     --args "${DEGRADATIONS[@]}" > "$REPORT_DIR/report.json"
  cat "$REPORT_DIR/report.json"
}

main() {
  phase0_preflight
  phase1_boot
  phase2_endpoint_surface
  phase3_expose
  phase4_retract
  phase5_restart
  phase6_net08_matrix
  phase7_teardown_selfproof_report
  if [ "${#DEGRADATIONS[@]}" -gt 0 ]; then printf 'DEGRADED: %s\n' "${DEGRADATIONS[@]}"; fi
  echo "phases 0-7: pass=$PASS fail=$FAIL required_fail=$REQUIRED_FAIL host_state_unchanged=$HOST_STATE_UNCHANGED (port=$PORT wsl_ip=$WSL_IP report=$REPORT_DIR/report.json)"
  # Exit 0 ONLY if no required failure AND the host-state self-proof held.
  # Tier-c degradation is NOT a failure; a tier-b failure IS (REQUIRED above).
  if [ "$REQUIRED_FAIL" = 0 ] && [ "$HOST_STATE_UNCHANGED" = 1 ]; then exit 0; else exit 1; fi
}
main "$@"
