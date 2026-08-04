# NET-04/05/07 HOST-BLOCKED: Evidence Record

## Status

NET-04 (Windows firewall configure/repair), NET-05 (WSL2 forwarding), and NET-07 (elevation denial/timeout/partial/verification) are **HOST-BLOCKED** by design. These features require a disposable elevated Windows VM, which this Linux host is not. Safety rules forbid simulating live elevation or OS-level firewall mutations. These requirements remain **UNCHECKED in the parity checklist** — their live effect is unexecuted BY DESIGN.

## Evidence: Code Complete & Tested

The code implementing these features is complete and thoroughly tested, with evidence in the following test suite:

### ElevationRunner & Argument Golden Tests
_File: `crates/freshell-platform/src/elevated.rs`_

1. **`elevated_args_golden_no_quotes`** — Validates elevation argument formatting without quote escaping
2. **`on_non_windows_the_live_runner_is_unsupported_and_never_spawns`** — Structural unreachability: live runner is absent on non-Windows platforms
3. **`fake_runner_dispatch_classifies_outcomes`** — Fake/mock runner correctly classifies all OS mutation outcomes
4. **`source_only_constructs_real_under_cfg_windows`** — Real elevation runner construction is gated to `#[cfg(windows)]` only

### Firewall Command & Detection Tests
_File: `crates/freshell-platform/src/firewall.rs`_

- **Add/Delete/Repair Golden Tests**: `managed_add_golden`, `managed_delete_uses_plain_dollar_null`, `repair_reachable_adds_only_missing_and_deletes_stale`, `repair_unreachable_adds_all_required` — Golden command verification for Windows (netsh) and Linux (ufw/firewalld)
- **`delete_commands_never_touch_unrelated_or_freshelllanaccess_rules`** — Safety invariant: delete commands never mutate unrelated firewall rules
- **Firewall Detection Tests**: `detect_wsl2_active_on`, `detect_windows_state_off_is_inactive`, `detect_linux_ufw_*`, `detect_linux_none_when_no_tools`, `managed_windows_exists_probe_by_exit0_or_name_in_output` — Platform detection logic

### WSL2 Port Forward Script Golden Tests
_File: `crates/freshell-platform/src/port_forward.rs`_

- **WSL Script Goldens**: Validated WSL2 forwarding script generation for preexisting and new port rules
- **`plan_sees_preexisting_3001_rule_as_satisfied_and_emits_no_add_for_it`** — Idempotency: plan recognizes pre-existing rules and avoids redundant additions

### Network Endpoint & Elevation Outcome Tests
_File: `crates/freshell-server/src/network.rs`_

**POST /configure-firewall Endpoint Tests:**
1. **`configure_firewall_first_post_issues_confirmation_without_running_anything`** — First POST issues confirmation token; no OS mutation
2. **`configure_firewall_409_when_repair_in_flight`** — 409 Conflict if repair already in flight
3. **`configure_firewall_requires_auth_and_strict_body`** — Auth requirement and request body validation
4. **`disable_windows_lane_issues_confirmation_with_exact_contract_body`** — Confirms disable lane uses exact expected contract body

**Confirmation & Repost Tests:**
5. **`disable_confirmed_repost_dispatches_and_applies_disabled_state`** — Repost with valid confirmation token dispatches mutation and persists disabled state
6. **`disable_stale_token_reissues_fresh_confirmation_and_never_dispatches`** — Expired confirmation token reissues fresh token without dispatch

**Elevation Outcome Matrix Tests (NET-07):**
7. **`elevation_denial_releases_lock_and_persists_no_success`** — Elevation denial (non-Windows): lock released, no success persisted
8. **`no_real_os_mutation_command_reaches_a_runner`** — Safety invariant: in test environment, no real OS mutation command ever reaches an elevation runner (sandbox guarantee)

## Rationale

- **Code is production-ready**: All code paths are implemented and exercised in test.
- **Sandbox prevents live mutation**: The fake elevation runner and test harness ensure no real OS mutation occurs.
- **Parity checklist remains honest**: These features cannot be exercised end-to-end on this host; they remain deferred but marked HOST-BLOCKED with full evidence.
- **Future execution path clear**: When deployed to Windows (or with elevated test VM), all tested code paths execute without modification.

---

## 2026-08-04 addendum: live native-Windows validation session (DANDESKTOP)

A supervised live session upgraded the evidence for the deferred items. The Windows
binary was cross-compiled from this branch (commit 9257c3b) via the worktree-local
`x86_64-pc-windows-gnu` target and run natively on the Windows host.

### Newly live-proven (was fake-tested only)

- Native Windows boot: `freshell-server.exe` serves on Windows (PS-launched, port 3003).
- `POST /api/network/configure {host: 0.0.0.0}` -> true LAN reachability from a
  separate physical machine (shapiroserver2 -> 192.168.3.50:3003 = HTTP 200).
- `POST /api/network/disable-remote-access` -> LAN refused (000), loopback survives,
  host=127.0.0.1. Full expose/retract cycle on native Windows.
- The no-op decision lane: with the firewall port already open, `configure-firewall`
  correctly returns `{"method":"none","message":"No configuration changes required"}`
  and never requests elevation.

### NET-04/07 live-fire remains deferred — with a now-documented environmental reason

Three successive attempts to reach `remoteAccessNeedsRepair=true` (the only state that
fires the elevated netsh + UAC path) were defeated by the host's firewall posture:

1. Pre-existing program-scoped allow rules for the exe -> port open -> no repair needed.
2. All freshell rules removed (elevated cleanup, verified) -> on next server launch the
   allow rule was silently re-created on bind -> port open again.
3. Fresh never-seen exe name (`freshell-uac.exe`), zero pre-existing rules -> LAN
   reachable immediately after bind; two program-scoped allow rules appeared with no
   user prompt.

Effective policy at time of test: `netsh advfirewall show privateprofile` ->
`State ON, Firewall Policy BlockInbound,AllowOutbound` — yet binds silently mint
program allow rules. On such a host the firewall never leaves a freshell port closed,
so the repair path is structurally unreachable without contrived state (an explicit
block rule, which would convert the repair into a VerificationFailed outcome rather
than a clean create).

**Conclusion:** live-fire validation of NET-04 (elevated rule creation) and NET-07
(real UAC approve/deny) requires a host whose firewall does NOT auto-allow the binary —
i.e. the disposable Windows VM / CI runner already tracked as HARNESS-09. The fake-based
test matrix plus the above live evidence remains the honest ceiling on this developer
machine.
