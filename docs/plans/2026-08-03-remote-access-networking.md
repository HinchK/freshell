# Remote-Access Networking Completion Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking. Every task is self-contained — repeated code is intentional
> because a fresh implementer sees only their own task.

**Goal:** Finish the Rust Freshell server's remote-access networking surface —
the two mutation endpoints (`configure`, `disable-remote-access`) with a
genuinely transactional rebind, the `configure-firewall` endpoint with the full
confirmation-token protocol and Windows/WSL2 machinery behind injected fakes,
plus a live verification harness — matching the frozen TypeScript wire contract
exactly, all committed to `feat/remote-access-networking`.

**Architecture:** Slice 1 (live status + `GET /api/lan-info`) is already landed.
This plan adds Slice 0 (injection/timing hardening + WSL bind-precedence fix
in `freshell-platform`),
Slice 2 (Linux-live mutation endpoints with a bind-new-before-persist rebind
using `SO_REUSEPORT`), Slice 3 (`configure-firewall` + Windows/WSL2 elevation
behind a compile-time-unreachable real runner), and a `scripts/verify-remote-access.sh`
harness that proves expose/retract against a three-tier vantage ladder. All OS
mutation flows through an injected `CommandRunner`; on this Linux host the real
Windows-mutation path is structurally unreachable (a `#[cfg(windows)]`-only enum
variant), so tests exercise it via `FakeCommandRunner` with byte-exact golden
strings.

**Tech Stack:** Rust (edition 2021, rust-version 1.96), axum 0.8, tokio,
`socket2` (SO_REUSEPORT), `serde_json` (preserve_order), `uuid` v4, `tower`
(`ServiceExt::oneshot` for in-crate route tests), bash + curl + jq +
`powershell.exe`/`ssh` for the harness.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied
verbatim from the spec and the exploration.

- **Repo root (worktree):** `/home/dan/code/freshell/.worktrees/remote-access-networking`.
  All subagents/scripts run with an UNKNOWN working directory — always use
  absolute paths or `git -C <root>` / path-prefixed access. Never rely on cwd.
- **Branch:** `feat/remote-access-networking`. All work commits here. Uncommitted
  work is treated as nonexistent.
- **FROZEN — never edit:** `server/`, `shared/`, `src/`. They are the behavioral
  reference and the client contract. `git status --porcelain server/ shared/ src/`
  MUST stay empty; it is a falsifier in every code slice.
- **The TypeScript is the behavioral reference; the client is the contract.**
  Match the wire shapes the client reads exactly (`src/store/networkSlice.ts`,
  `src/components/settings/NetworkSettings.tsx`, `src/components/NetworkQuickAccess.tsx`,
  `src/lib/firewall-configure.ts`, `src/lib/share-utils.ts`).
- **Package scope for all Rust checks:**
  `cargo test -p freshell-server -p freshell-platform` and
  `cargo clippy -p freshell-server -p freshell-platform --all-targets -- -D warnings`
  and `cargo fmt --check`. `freshell-server` is `[[bin]]`-only (no `src/lib.rs`),
  so route unit tests live IN-crate as `#[cfg(test)] mod tests`; cross-process
  tests live in `crates/freshell-server/tests/*.rs` and spawn the compiled binary.
- **Baseline after Slice 1:** `cargo test -p freshell-server -p freshell-platform`
  is green (~708–718 passed, 0 failed, 1 ignored). Never reduce this; only add.
- **SAFETY — never execute mutating OS network/firewall commands on this host:**
  no `netsh ... add/delete/set`, no `netsh interface portproxy add/delete`, no
  `Start-Process -Verb RunAs`, no `ufw`/`iptables`. Mutation exists ONLY as
  golden-string builders dispatched through an injected `CommandRunner`, which in
  every test is a `FakeCommandRunner`. Read-only `netsh ... show all` /
  `netsh advfirewall firewall show rule` via `powershell.exe` is the ONLY
  permitted `netsh` use. Rebinding our OWN listener (`127.0.0.1` ↔ `0.0.0.0`) is
  allowed — our socket, not OS-global state.
- **PORT 3001 POLICY (critical):** the user's LIVE Freshell instance holds
  `0.0.0.0:3001` and serves real sessions. DO NOT kill it; DO NOT bind 3001 while
  it runs. All harness endpoint/expose/retract tests run on an ephemeral high
  test port using tiers (a)+(b). Tier (c) needs 3001 → gate it behind a flag and
  degrade-with-documented-reason otherwise. If a brief 3001 takeover seems
  needed, STOP and surface to the user — do not act.
- **Vantage ladder** (all three verified live 2026-08-03): (a) WSL loopback
  `curl http://127.0.0.1:$PORT/`; (b) Windows host
  `powershell.exe Invoke-WebRequest http://<eth0 IP>:$PORT/` — re-resolve eth0 IP
  each run via `ip -4 addr show eth0` — HTTP 200 truthfully means 0.0.0.0-bound,
  connection refused truthfully means loopback-bound, works on ANY port,
  **REQUIRED / never degradable**; (c) true LAN
  `ssh shapiroserver2 curl http://192.168.3.50:3001/...`, valid ONLY on port 3001.
- **Deviations:** where the TS is buggy, fix it and record the deviation in
  `port/oracle/DEVIATIONS.md` with status `proposed` (Task 6.1). Working behavior
  over bug-for-bug parity. Do NOT replicate the wsl2
  `remoteAccessEnabled = rawPortOpen === true` predicate as a bug — it is the
  client contract (`src/lib/share-utils.ts`); Slice 1 already ports it faithfully.
- **Commits:** conventional-commit messages, one commit per work item, each with
  its own falsifier output pasted into the commit body, plus the Amplifier
  co-author attribution block:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)

  Co-Authored-By: Claude <noreply@anthropic.com>
  ```
- **Anti-fabrication contract:** every work item gets its own commit and its own
  falsifier that FAILS if that item alone is skipped. Falsifiers must be decidable
  without prose interpretation (a grep verdict, a passing test, an exit code).
- **README.md** is the only end-user markdown doc; this plan and the
  deferred-evidence doc live under `docs/plans/` and are working/agent docs.

---

## UNRESOLVED COVERAGE GAPS

None. NET-04, NET-05, and NET-07 require a disposable **elevated Windows VM** that
this Linux host is not and that the safety rules forbid simulating; they are
therefore **HOST-BLOCKED / deferred-with-evidence** — the *production code paths*
for them are fully implemented and exercised through `FakeCommandRunner` with
byte-exact golden strings and a compile-time unreachability proof (Tasks 3.1–3.5),
and the deferral is recorded with evidence in Task 3.6. This is not a stub
standing in for missing behavior: the behavior is built and tested; only the
*live elevated side effect* is unexecuted, by design, because executing it
requires hardware this host lacks. This disposition is the spec's own: it
explicitly orders these implemented "behind fakes ... structurally unreachable"
and "documented as deferred-with-evidence". Every other NET requirement
(NET-01/02/03/06/08/09/10) is evidenced live by the harness (Tasks 5.x). See the
coverage table in the Self-Review section.

---

## File Structure

New and modified files, by responsibility. Line numbers are from the current tree
(`13c5c34e8`) and are anchors — resolve by name if they drift.

| File | Responsibility | Slice |
|---|---|---|
| `crates/freshell-platform/src/elevated.rs` | Confirmation gate token compare → constant-time; add `ElevationRunner` enum (structural unreachability) + NET-07 outcome variants | 0, 3 |
| `crates/freshell-platform/src/port_forward.rs` | `wsl_ip: &str` → `std::net::Ipv4Addr` across builders/plans/reads (kills the injection sink) | 0 |
| `crates/freshell-platform/src/network.rs` | `resolve_bind_host`: persisted `configured:true` host outranks the WSL wildcard default (restart truthfulness) | 0 |
| `crates/freshell-server/src/net_bind.rs` | **NEW.** `SO_REUSEPORT`/`SO_REUSEADDR` listener factory; `RebindController` (bind-new → prove → persist → drain old); own accept loop; `notify_one` + JoinHandle barrier (old socket provably closed before responding) | 2 |
| `crates/freshell-server/src/network.rs` | Two POST routes (`configure`, `disable-remote-access`); `configure-firewall` route; wire `broadcast_tx`, `RebindController`, `Arc<Mutex<ConfirmationGate>>`, managed-ports store into `NetworkState`; shared action-resolution ladder | 2, 3 |
| `crates/freshell-server/src/managed_ports.rs` | **NEW.** Instance-scoped Windows/WSL managed-remote-access-ports persistence (fake-backed, honours `FRESHELL_HOME`, atomic) | 3 |
| `crates/freshell-server/src/main.rs` | Restructure serving so the boot listener is spawned via `RebindController`; boot bind honors persisted `settings.network`; inject `broadcast_tx`, controller, gate, managed-ports store into `NetworkState` | 2, 3 |
| `crates/freshell-server/Cargo.toml` | Add `socket2 = { version = "0.6", features = ["all"] }` | 2 |
| `crates/freshell-server/tests/net09_config_preservation.rs` | **NEW.** Black-box binary test: byte-preservation of unmanaged config across a network mutation + restart | 2 |
| `scripts/verify-remote-access.sh` | **NEW.** End-to-end live verification harness (7 phases, 3-tier ladder, NET-08 matrix, read-only host-state identity self-proof, `report.json`) | Harness |
| `docs/plans/2026-07-28-net-windows-deferred-evidence.md` | **NEW.** HOST-BLOCKED evidence record for NET-04/05/07 | 3 |
| `port/oracle/DEVIATIONS.md` | Append `proposed` deviation entries | 6 |

---

## Task ordering and dependencies

- **Slice 0** (Tasks 0.1–0.3) — `freshell-platform` only; independent of Slice 2's
  early tasks; a HARD BLOCKER for Slice 3 (wiring callers onto an unfixed
  `wsl_ip: &str` promotes the injection sink from latent to live), and Task 0.3
  is a HARD BLOCKER for Task 2.2b + harness Phase 5 (validated: without it a WSL
  restart ignores the persisted host — ledger A-04, reports/V2.md). Land first.
- **Slice 2** (Tasks 2.1–2.5) — depends on Slice 1 (landed).
- **Slice 3** (Tasks 3.1–3.6) — depends on Slice 0 AND Slice 2.
- **Harness** (Tasks 5.1–5.5) — depends on Slices 2 and 3 (it curls all five
  endpoints). Write it last.
- **Deviations** (Task 6.1) — after the code slices; documents the choices made.

Each slice is Red-Green-Refactor and committed before the next begins.

---

# SLICE 0 — Injection & timing hardening + bind-precedence fix (freshell-platform)

Three tasks, `freshell-platform` only, no wire change. The prior attempt at
`.ai/attempt5-slice3-partial.patch` is REFERENCE-ONLY inspiration (it is
uncommitted and its two `get_wsl_ip_rejects_injection_shaped_*` tests are weak —
they pass on pre-patch code; strengthen them here so the falsifier truly fails if
the item is skipped).

## Task 0.1: Constant-time confirmation-token compare

**Files:**
- Modify: `crates/freshell-platform/src/elevated.rs:168-200` (`matches_confirmation`, `consume_current_confirmation`)
- Test: `crates/freshell-platform/src/elevated.rs` `#[cfg(test)] mod tests` (starts `:268`)

**Interfaces:**
- Consumes: `freshell_platform::network::timing_safe_compare` (`crates/freshell-platform/src/network.rs:212`, signature `pub fn timing_safe_compare(a: &str, b: &str) -> bool` or `(&[u8],&[u8])` — verify by reading its definition and matching the call).
- Produces: unchanged public signatures for `ConfirmationGate::matches_confirmation` and `::consume_current_confirmation`; behavior identical for valid tokens, now constant-time.

- [ ] **Step 1: Write the failing tests**

Add to `crates/freshell-platform/src/elevated.rs` inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn matches_confirmation_uses_constant_time_compare_not_equality() {
    // Falsifier for NET-08-C: this test fails only if `==` is still used,
    // because it asserts the source no longer contains the equality compare.
    // Both needles are concat!-split so this test's OWN source never contains
    // them intact -- otherwise the negative assert would fail forever and the
    // positive assert would pass vacuously.
    let src = include_str!("elevated.rs");
    let banned = concat!("c.token ", "== t");
    let required = concat!("timing_safe", "_compare");
    assert!(
        !src.contains(banned),
        "raw == token compare still present; NET-08-C not applied"
    );
    assert!(
        src.contains(required),
        "constant-time compare not wired into the confirmation gate"
    );
}

#[test]
fn matches_confirmation_rejects_equal_length_mismatched_token() {
    let mut gate = ConfirmationGate::new();
    let issued = gate.issue_confirmation(ConfirmationAction::WindowsRepair, "aaaaaaaa");
    // Same length, different content -> must NOT match.
    assert!(!gate.matches_confirmation(Some("bbbbbbbb"), ConfirmationAction::WindowsRepair));
    // The genuinely-issued token still matches.
    assert!(gate.matches_confirmation(Some(&issued.confirmation_token), ConfirmationAction::WindowsRepair));
}

#[test]
fn consume_current_confirmation_rejects_differing_length_token() {
    let mut gate = ConfirmationGate::new();
    let issued = gate.issue_confirmation(ConfirmationAction::Wsl2Repair, "tokseed");
    assert!(!gate.consume_current_confirmation(Some("x")));
    assert!(gate.consume_current_confirmation(Some(&issued.confirmation_token)));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-platform elevated:: 2>&1 | tail -30`
Expected: `matches_confirmation_uses_constant_time_compare_not_equality` FAILS
(`raw == token compare still present`).

- [ ] **Step 3: Apply the constant-time compare**

At the top of `elevated.rs` add the import (place near the other `use crate::` lines):

```rust
use crate::network::timing_safe_compare;
```

Replace the equality compare at `elevated.rs:170` (inside `matches_confirmation`):

```rust
// before: this arm compared the tokens with the `==` operator (do NOT
// reproduce the old expression anywhere in this file, even in a comment --
// the Step 5 grep falsifier requires zero matches)
(Some(c), Some(t)) => timing_safe_compare(&c.token, t) && c.action == action,
```

Replace the equality guard at `elevated.rs:194` (inside `consume_current_confirmation`):

```rust
// before: this guard compared the tokens with the `==` operator
(Some(c), Some(t)) if timing_safe_compare(&c.token, t) => {
```

If `timing_safe_compare` takes `&[u8]`, call `timing_safe_compare(c.token.as_bytes(), t.as_bytes())` instead — read `crates/freshell-platform/src/network.rs:212` first and match the exact signature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-platform elevated:: 2>&1 | tail -30`
Expected: all three new tests PASS; the pre-existing gate tests
(`phase1_issues_token_and_never_spawns`, `confirm_with_wrong_token_reissues_and_does_not_spawn`, etc.) still PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
grep -c 'c\.token == t' crates/freshell-platform/src/elevated.rs        # must be 0
grep -c 'timing_safe_compare' crates/freshell-platform/src/elevated.rs  # must be >0
cargo test -p freshell-platform -p freshell-server 2>&1 | tail -5
cargo clippy -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-platform/src/elevated.rs
git commit  # message below, paste falsifier output into the body
```

Commit message: `fix(net): constant-time confirmation-token compare (NET-08-C)`

## Task 0.2: Type `wsl_ip` as `Ipv4Addr` to make command injection unrepresentable

**Files:**
- Modify: `crates/freshell-platform/src/port_forward.rs` — `WslPortForwardingPlan` fields (`:58-71`), `build_port_forwarding_script` (`:327`), `needs_port_forwarding_update` (`:280`), `build_wsl_port_forwarding_plan` (`:413`), `get_wsl_ip` (`:549`)
- Test: `crates/freshell-platform/src/port_forward.rs` `#[cfg(test)] mod tests` (starts `:598`)
- Sweep: any caller in `crates/` that constructs/reads these (compile check catches them)

**Interfaces:**
- Consumes: `std::net::Ipv4Addr`.
- Produces:
  - `WslPortForwardingPlan::Noop { wsl_ip: Ipv4Addr }` and
    `::Ready { wsl_ip: Ipv4Addr, script_kind: ScriptKind, script: String }`
  - `pub fn build_port_forwarding_script(wsl_ip: Ipv4Addr, ports: &[u16], cleanup_ports: &[u16]) -> String`
  - `pub fn needs_port_forwarding_update(wsl_ip: Ipv4Addr, required_ports: &[u16], existing_rules: &BTreeMap<u16, PortProxyRule>) -> bool`
  - `pub fn build_wsl_port_forwarding_plan(required_ports: &[u16], known_owned_ports: &[u16], wsl_ip: Ipv4Addr, existing_rules: &BTreeMap<u16, PortProxyRule>, existing_firewall_ports: &[u16], managed_ports: &[u16]) -> WslPortForwardingPlan`
  - `pub fn get_wsl_ip(runner: &dyn CommandRunner) -> Option<Ipv4Addr>`
  - **Golden script strings are UNCHANGED** (`Ipv4Addr::to_string()` renders `172.30.149.249` identically). This is a security-only change.

- [ ] **Step 1: Write the failing tests**

Add to `crates/freshell-platform/src/port_forward.rs` inside `#[cfg(test)] mod tests`. The key strengthening over the prior attempt: a payload that *passes* a shape heuristic but *fails* `Ipv4Addr::from_str`, so the test cannot pass on pre-change code.

```rust
use std::net::Ipv4Addr;

#[test]
fn wsl_ip_injection_payloads_cannot_be_typed_as_ipv4() {
    // Each of these is a command-injection attempt; none is a valid Ipv4Addr.
    let payloads = [
        "1.2.3.4; calc",
        "1.2.3.4\nnetsh interface portproxy add",
        "1.2.3.4`whoami`",
        "$(id)",
        "1.2.3.4 | rm -rf /",
        "999.1.1.1",          // passes a naive digit/dot shape, fails real parse
        "1.2.3.4.5",
        "",
        "0x7f.0.0.1",
    ];
    for p in payloads {
        assert!(
            p.parse::<Ipv4Addr>().is_err(),
            "payload unexpectedly parsed as Ipv4Addr: {p:?}"
        );
    }
}

#[test]
fn get_wsl_ip_returns_none_for_shape_valid_but_unparseable_output() {
    // eth0 output whose token passes a digits-and-dots heuristic but is not a
    // real IPv4 address. Pre-change (String) code would have returned Some("999.1.1.1").
    let runner = crate::FakeCommandRunner::new().on(
        "ip",
        &["addr", "show", "eth0"],
        crate::CommandOutput::success("    inet 999.1.1.1/24 brd ... scope global eth0"),
    );
    assert_eq!(get_wsl_ip(&runner), None);
}

#[test]
fn get_wsl_ip_parses_a_real_ipv4() {
    let runner = crate::FakeCommandRunner::new().on(
        "ip",
        &["addr", "show", "eth0"],
        crate::CommandOutput::success("    inet 172.30.149.249/20 brd ... scope global eth0"),
    );
    assert_eq!(get_wsl_ip(&runner), Some(Ipv4Addr::new(172, 30, 149, 249)));
}

#[test]
fn port_forwarding_script_bytes_unchanged_under_ipv4_typing() {
    // Golden lock: the emitted script must be byte-identical to the pre-change
    // output for a valid IP. (Copy the exact expected string from the existing
    // `port_forwarding_script_golden_raw_backslash` test at :623 before editing.)
    let script = build_port_forwarding_script(Ipv4Addr::new(172, 30, 149, 249), &[3001], &[3001]);
    assert!(script.contains("connectaddress=172.30.149.249"));
    assert!(script.contains("2>\\$null")); // raw backslash-dollar preserved
}
```

Before editing, **read the existing golden tests** `port_forwarding_script_golden_raw_backslash` (`:623`) and `port_forwarding_script_multiport_and_distinct_cleanup` (`:638`) and update their call sites to pass `Ipv4Addr` literals (`"172.30.149.249".parse().unwrap()`), keeping the expected strings byte-identical.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-platform port_forward:: 2>&1 | tail -30`
Expected: compile error (the new tests reference the `Ipv4Addr` signatures that
don't exist yet), or the existing goldens fail to compile.

- [ ] **Step 3: Apply the type change**

At the top of `port_forward.rs`: `use std::net::Ipv4Addr;`

Change the plan enum (`:58-71`):

```rust
pub enum WslPortForwardingPlan {
    NotWsl2,
    Disabled,
    Error(String),
    Noop { wsl_ip: Ipv4Addr },
    Ready { wsl_ip: Ipv4Addr, script_kind: ScriptKind, script: String },
}
```

Change `build_port_forwarding_script` (`:327`) — internally bind `let wsl_ip = wsl_ip.to_string();` at the top so the rest of the body is unchanged:

```rust
pub fn build_port_forwarding_script(wsl_ip: Ipv4Addr, ports: &[u16], cleanup_ports: &[u16]) -> String {
    let wsl_ip = wsl_ip.to_string();
    // ... existing body unchanged (interpolates `connectaddress={wsl_ip}`) ...
}
```

Change `needs_port_forwarding_update` (`:280`) similarly (bind `let wsl_ip_str = wsl_ip.to_string();`, compare `rule.connect_address != wsl_ip_str`).

Change `build_wsl_port_forwarding_plan` (`:413`) signature to take `wsl_ip: Ipv4Addr`; drop the `.to_string()` at the `Noop { wsl_ip }` / `Ready { wsl_ip, .. }` construction sites (the field is now `Ipv4Addr`); call `build_port_forwarding_script(wsl_ip, ...)` directly.

Change `get_wsl_ip` (`:549`) to parse at the read boundary:

```rust
pub fn get_wsl_ip(runner: &dyn CommandRunner) -> Option<Ipv4Addr> {
    // ... existing eth0-then-hostname extraction yields a &str candidate ...
    // then, at each return point:
    candidate.trim().parse::<Ipv4Addr>().ok()
}
```

- [ ] **Step 4: Caller sweep — compile the whole scope**

Run: `cargo build -p freshell-platform -p freshell-server 2>&1 | tail -40`
Fix every call site the compiler flags (e.g. any code reading `plan.wsl_ip` now
gets an `Ipv4Addr`; if it needs a string, call `.to_string()`). If a caller
`Serialize`s `WslPortForwardingPlan`, add a test asserting `Ipv4Addr` serializes
as `"172.30.149.249"` (same wire shape). At `13c5c34e8` there are no
`freshell-server` callers, but do not assume — let the compiler prove it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p freshell-platform port_forward:: 2>&1 | tail -30`
Expected: new tests PASS; all pre-existing `port_forward` golden tests PASS
(strings byte-identical).

- [ ] **Step 6: Falsifier + commit**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
grep -c 'fn build_port_forwarding_script(wsl_ip: &str' crates/freshell-platform/src/port_forward.rs  # must be 0
grep -Ec 'wsl_ip: Ipv4Addr|wsl_ip: std::net::Ipv4Addr' crates/freshell-platform/src/port_forward.rs  # must be >0
cargo test -p freshell-platform -p freshell-server 2>&1 | tail -5
cargo clippy -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-platform/src/port_forward.rs
git commit  # paste falsifier output into the body
```

Commit message: `fix(net): type wsl_ip as Ipv4Addr, making command injection unrepresentable (NET-08-A/B)`

## Task 0.3: `resolve_bind_host` — persisted `configured` intent outranks the WSL default

**Files:**
- Modify: `crates/freshell-platform/src/network.rs` — `resolve_bind_host` (~`:49-91`) + its doc comment (`:45-48`)
- Test: same file's `#[cfg(test)] mod tests`

**Why (VALIDATED — ledger A-04, reports/V2.md):** at HEAD, `network.rs:57-59`
returns `"0.0.0.0"` for WSL BEFORE consulting the config (confirmed by a live
run: `is_wsl=true` + `Ok { raw_host: Some("127.0.0.1"), configured: true }` →
`"0.0.0.0"`). The frozen TS reference does the same (`server/get-network-host.ts:42`),
so this is a DELIBERATE divergence — record it as deviation entry #8 (Task 6.1):
after a disable persists `{host:"127.0.0.1",configured:true}`, a WSL restart must
NOT silently re-expose. Only `configured: true` config outranks the WSL default;
unconfigured WSL keeps `0.0.0.0` (`scripts/run-rust-server.sh` relies on that).
The contested precedence cell is unpinned by any existing test, so nothing breaks.

**Interfaces:**
- Produces: unchanged signature `resolve_bind_host(env, is_wsl, config) -> String`;
  new precedence: `FRESHELL_BIND_HOST` → persisted config (when `configured: true`,
  valid host) → WSL default `0.0.0.0` → config raw_host hint → `HOST` → `127.0.0.1`.

- [ ] **Step 1: Write the failing tests**

Read the neighboring tests `wsl_forces_0000` (`:568-574`) and
`bind_override_invalid_falls_through` (`:559-566`) first and copy their env-fake
construction style exactly. Then add:

```rust
#[test]
fn wsl_with_configured_host_outranks_wsl_default() {
    // env WITHOUT FRESHELL_BIND_HOST / HOST set
    let host = resolve_bind_host(&test_env_without_overrides(), true, BindHostConfig::Ok {
        raw_host: Some("127.0.0.1".into()), configured: true });
    assert_eq!(host, "127.0.0.1");
}

#[test]
fn wsl_unconfigured_keeps_wildcard_default() {
    let host = resolve_bind_host(&test_env_without_overrides(), true, BindHostConfig::Ok {
        raw_host: Some("127.0.0.1".into()), configured: false });
    assert_eq!(host, "0.0.0.0");
}
```

(`test_env_without_overrides()` = whatever fake-env helper the existing tests in
this module use — match it, do not invent a new one.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-platform network:: 2>&1 | tail -20`
Expected: `wsl_with_configured_host_outranks_wsl_default` FAILS (gets `0.0.0.0`).

- [ ] **Step 3: Apply the precedence change**

In `resolve_bind_host`, BEFORE the `if is_wsl { return "0.0.0.0" ... }` branch,
return the configured host when the config is `Ok { raw_host: Some(h), configured: true }`
and `h` passes the function's existing host validation; keep `FRESHELL_BIND_HOST`
above everything. Update the doc comment (`:45-48`) to the new order.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-platform network:: 2>&1 | tail -10`
Expected: both new tests PASS; `wsl_forces_0000` and every other existing
precedence test still PASS (they exercise `BindHostConfig::Failed` / unconfigured
paths, which are unchanged).

- [ ] **Step 5: Falsifier + commit**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
grep -c 'wsl_with_configured_host_outranks_wsl_default' crates/freshell-platform/src/network.rs  # must be >0
cargo test -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-platform/src/network.rs
git commit  # paste falsifier output
```

Commit message: `fix(net): persisted configured host outranks the WSL wildcard default (restart truthfulness)`

---

# SLICE 2 — Mutation endpoints, Linux-live

`POST /api/network/configure` and `POST /api/network/disable-remote-access`
really expose and really retract, transactionally, through the serialized config
store. This is the primary evidence for NET-02 (transactional rebind, exceeding
the reference), NET-06 (safe disable, Linux lane), and NET-09 (lossless writes),
plus NET-01/03/08.

## Task 2.1: `SO_REUSEPORT` listener factory + `RebindController`

**Files:**
- Create: `crates/freshell-server/src/net_bind.rs`
- Modify: `crates/freshell-server/Cargo.toml` (add `socket2 = { version = "0.6", features = ["all"] }`)
- Modify: `crates/freshell-server/src/main.rs` (add `mod net_bind;` near the other `mod` declarations)
- Test: `crates/freshell-server/src/net_bind.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `socket2`, `tokio::net::TcpListener`, `axum::Router`, `tokio::sync::Notify`.
- Produces:
  - `pub fn bind_reusable(addr: std::net::SocketAddr, reuse_port: bool) -> std::io::Result<std::net::TcpListener>` — a std listener with `SO_REUSEADDR` (+ `SO_REUSEPORT` on unix when `reuse_port`), nonblocking, listening.
  - `pub fn parse_reuse_port(raw: Option<&str>) -> bool` — `false` iff raw ∈ {`1`,`true`,`yes`} (case-insensitive), else `true`.
  - `pub fn reuse_port_enabled() -> bool` — reads `FRESHELL_REBIND_NO_REUSEPORT`.
  - `pub struct RebindController` with `new`, `set_app`, `has_app`, `serve_on`, `shutdown_all` (see body in Step 4). `serve_on` returns only after the OLD listener is provably closed (permit-storing `notify_one` + accept-loop `JoinHandle` barrier — VALIDATED design, ledger A-03: the naive `notify_waiters`-and-no-barrier version loses 57–99/100 wakeups and resets 42–50/100 immediate probes); in-flight connections keep draining in their own tasks.

- [ ] **Step 1: Add the dependency**

Edit `crates/freshell-server/Cargo.toml`, in `[dependencies]`:

```toml
socket2 = { version = "0.6", features = ["all"] }
hyper = "1"
hyper-util = { version = "0.1", features = ["tokio", "server", "server-auto", "service"] }
tower = { version = "0.5", features = ["util"] }
```

All four VERSIONS already resolve in `Cargo.lock` (socket2 0.6.4 via
`freshell-ws`'s dev-dependencies; hyper/hyper-util/tower via axum), but
`features = ["all"]` on socket2 is REQUIRED here: `Socket::set_reuse_port`
is gated behind the `all` feature, socket2 ships no default features, and a
dependency's dev-dependencies do NOT unify features into this crate's build.
Without it, `bind_reusable` fails to compile (`no method named
set_reuse_port`). `tower` may already sit in `[dev-dependencies]` — having
it in both sections is legal; leave the dev line.

Run: `cargo build -p freshell-server 2>&1 | tail -5`.

- [ ] **Step 2: Write the failing tests**

Create `crates/freshell-server/src/net_bind.rs` with only the tests first (module body added in Step 4). Put this at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn free_port() -> u16 {
        let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        l.local_addr().unwrap().port()
    }

    #[test]
    fn reuse_port_kill_switch_reads_env() {
        assert!(parse_reuse_port(None));
        assert!(!parse_reuse_port(Some("1")));
        assert!(!parse_reuse_port(Some("TRUE")));
        assert!(!parse_reuse_port(Some("yes")));
        assert!(parse_reuse_port(Some("0")));
        assert!(parse_reuse_port(Some("")));
    }

    #[test]
    fn two_reuseport_binds_on_same_addr_both_succeed() {
        let port = free_port();
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let a = bind_reusable(addr, true).expect("first reuseport bind");
        let b = bind_reusable(addr, true).expect("second reuseport bind must also succeed");
        drop((a, b));
    }

    #[test]
    fn foreign_squatter_blocks_our_bind() {
        let port = free_port();
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
        let squatter = std::net::TcpListener::bind(addr).expect("squatter binds");
        let result = bind_reusable(addr, true);
        assert!(result.is_err(), "reuseport bind must still fail against a foreign non-reuseport squatter");
        drop(squatter);
    }

    #[tokio::test]
    async fn serve_on_proves_bind_before_swapping_and_serves_traffic() {
        use axum::{routing::get, Router};
        let port = free_port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        ctl.serve_on(IpAddr::V4(Ipv4Addr::LOCALHOST)).await.expect("initial serve");
        let body = reqwest::get(format!("http://127.0.0.1:{port}/ping")).await.unwrap().text().await.unwrap();
        assert_eq!(body, "pong");
        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED)).await.expect("rebind serve");
        let body2 = reqwest::get(format!("http://127.0.0.1:{port}/ping")).await.unwrap().text().await.unwrap();
        assert_eq!(body2, "pong");
        ctl.shutdown_all().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hundred_rapid_rebinds_never_lose_a_listener_or_reset_a_probe() {
        // Falsifier for the validated lost-wakeup/drain race (ledger A-03,
        // reports/V1.md): with notify_waiters and no barrier, 42-99/100 of
        // these iterations fail. Do NOT weaken this test.
        use axum::{routing::get, Router};
        let port = free_port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let wildcard = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        ctl.serve_on(localhost).await.expect("initial serve");
        for i in 0..100 {
            let target = if i % 2 == 0 { wildcard } else { localhost };
            ctl.serve_on(target).await.expect("swap");
            // serve_on returned => the OLD listener is closed (barrier), so an
            // immediate probe must hit the new listener, never ConnectionReset.
            let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
                .await.expect("probe connects").text().await.unwrap();
            assert_eq!(body, "pong", "swap #{i}");
        }
        ctl.shutdown_all().await;
        // Port fully released: a plain (non-reuseport) bind succeeds only if no
        // stuck listener remains (the lost-wakeup failure mode).
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .expect("no stuck listeners after 100 swaps");
    }
}
```

`reqwest` is already a `freshell-server` dependency (in `[dependencies]`, v0.13 — available to unit tests as-is; VALIDATED, reports/V7.md).

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p freshell-server net_bind:: 2>&1 | tail -20`
Expected: compile failure (module body absent).

- [ ] **Step 4: Implement the module body**

Prepend, above the `#[cfg(test)]` block in `crates/freshell-server/src/net_bind.rs`:

```rust
//! Listener binding for the transactional rebind (NET-02).
//!
//! We create every listener (boot AND rebind) with SO_REUSEADDR + SO_REUSEPORT
//! so a new listener can be *proven to bind* before we persist the config and
//! retire the old one. Rollback is dropping the new socket — an infallible
//! no-op. There is never a zero-listener window and persisted state never
//! outruns reality. The `FRESHELL_REBIND_NO_REUSEPORT=1` escape hatch disables
//! SO_REUSEPORT (falls back to a best-effort bind a foreign squatter can block).
//!
//! Drain design (VALIDATED — ledger A-03 falsified the naive version): the
//! controller owns its own accept loop per listener. Retiring a listener uses
//! `Notify::notify_one()` (permit-storing: the wakeup cannot be lost, unlike
//! `notify_waiters`) and then AWAITS the old accept-loop `JoinHandle`, which
//! exits only after dropping its listener — a deterministic "old socket
//! closed" barrier, so callers may respond/probe immediately after `serve_on`
//! returns. In-flight connections (incl. WebSockets) drain in their own
//! spawned tasks — no mass 4009 on rebind.
//!
//! Trade-off: SO_REUSEPORT lets another process of the same effective UID bind
//! the port. On a single-user self-hosted box that is inside the same trust
//! boundary as the auth token.

use std::net::{IpAddr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::{Arc, OnceLock};

use axum::Router;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

pub fn parse_reuse_port(raw: Option<&str>) -> bool {
    match raw {
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        None => true,
    }
}

pub fn reuse_port_enabled() -> bool {
    parse_reuse_port(std::env::var("FRESHELL_REBIND_NO_REUSEPORT").ok().as_deref())
}

pub fn bind_reusable(addr: SocketAddr, reuse_port: bool) -> std::io::Result<StdTcpListener> {
    let domain = match addr.ip() {
        IpAddr::V4(_) => Domain::IPV4,
        IpAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    if reuse_port {
        socket.set_reuse_port(true)?;
    }
    #[cfg(not(unix))]
    let _ = reuse_port;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    let std_listener: StdTcpListener = socket.into();
    std_listener.set_nonblocking(true)?;
    Ok(std_listener)
}

/// One live listener: its shutdown signal + the accept-loop task handle. The
/// accept loop drops its listener before exiting, so awaiting the handle is a
/// true "old socket closed" barrier.
struct LiveListener {
    shutdown: Arc<Notify>,
    accept_loop: JoinHandle<()>,
}

pub struct RebindController {
    port: u16,
    reuse_port: bool,
    app: OnceLock<Router>,
    current: Mutex<Option<LiveListener>>,
}

impl RebindController {
    pub fn new(port: u16, reuse_port: bool) -> Arc<Self> {
        Arc::new(Self { port, reuse_port, app: OnceLock::new(), current: Mutex::new(None) })
    }

    pub fn set_app(&self, app: Router) {
        let _ = self.app.set(app); // first (full) app wins
    }

    pub fn has_app(&self) -> bool {
        self.app.get().is_some()
    }

    /// Bind `host:port` (proof), start our own accept loop, then retire the old
    /// listener: `notify_one` (permit-storing, cannot be lost) + await its
    /// JoinHandle (deterministic closed barrier). On bind failure the previous
    /// listener is left untouched (no swap). When no app has been injected
    /// (unit tests) this is an Ok no-op so validation and persistence can be
    /// tested without a real socket.
    pub async fn serve_on(&self, host: IpAddr) -> std::io::Result<()> {
        let Some(app) = self.app.get().cloned() else { return Ok(()); };
        let addr = SocketAddr::new(host, self.port);
        let std_listener = bind_reusable(addr, self.reuse_port)?; // PROOF: must succeed
        let listener = tokio::net::TcpListener::from_std(std_listener)?;
        let shutdown = Arc::new(Notify::new());
        let shut = Arc::clone(&shutdown);
        let accept_loop = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shut.notified() => break,
                    res = listener.accept() => {
                        let Ok((stream, _remote)) = res else { continue };
                        let app = app.clone();
                        tokio::spawn(async move {
                            // axum 0.8 "serve with hyper directly" pattern — if the
                            // compiler objects to the service shape, mirror the
                            // vendored axum example `serve-with-hyper` exactly.
                            // `serve_connection_with_upgrades` keeps WebSockets working.
                            use tower::ServiceExt as _;
                            let socket = hyper_util::rt::TokioIo::new(stream);
                            let hyper_service = hyper::service::service_fn(
                                move |request: hyper::Request<hyper::body::Incoming>| {
                                    app.clone().oneshot(request)
                                },
                            );
                            let _ = hyper_util::server::conn::auto::Builder::new(
                                hyper_util::rt::TokioExecutor::new(),
                            )
                            .serve_connection_with_upgrades(socket, hyper_service)
                            .await;
                        });
                    }
                }
            }
            // `listener` is dropped HERE, before the task completes: awaiting
            // this JoinHandle is a true "old listener closed" barrier.
        });
        let mut cur = self.current.lock().await;
        if let Some(old) = cur.replace(LiveListener { shutdown, accept_loop }) {
            old.shutdown.notify_one(); // permit-storing: never lost
            let _ = old.accept_loop.await; // barrier: old socket provably closed
        }
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        if let Some(cur) = self.current.lock().await.take() {
            cur.shutdown.notify_one();
            let _ = cur.accept_loop.await;
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p freshell-server net_bind:: 2>&1 | tail -20`
Expected: all `net_bind` tests PASS.

- [ ] **Step 6: Falsifier + commit**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
grep -c 'socket2' crates/freshell-server/Cargo.toml                    # must be >0
grep -c 'pub struct RebindController' crates/freshell-server/src/net_bind.rs  # must be >0
grep -c 'notify_one' crates/freshell-server/src/net_bind.rs                    # must be >0 (A-03 fix present)
grep -c 'notify_waiters' crates/freshell-server/src/net_bind.rs                # must be 0 (lost-wakeup API banned here)
cargo test -p freshell-server net_bind:: 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/Cargo.toml crates/freshell-server/src/net_bind.rs crates/freshell-server/src/main.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): SO_REUSEPORT listener factory + transactional RebindController (NET-02)`

## Task 2.2: Wire `broadcast_tx` + `RebindController` into `NetworkState`; serve the boot listener through the controller

**Files:**
- Modify: `crates/freshell-server/src/network.rs:146-173` (`NetworkState` fields)
- Modify: `crates/freshell-server/src/main.rs:900-907` (construction), `:1354-1381` (serving)
- Test: `crates/freshell-server/src/network.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `net_bind::RebindController`, the process `broadcast_tx` (built at `main.rs:212`).
- Produces: `NetworkState` gains `pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>` and `pub rebind: Arc<crate::net_bind::RebindController>`, plus `pub fn broadcast_settings_updated(&self, settings: &ServerSettings)`.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn broadcast_settings_updated_emits_the_settings_updated_frame() {
    let state = test_state("127.0.0.1", None); // updated helper returns a state with a live broadcast_tx
    let mut rx = state.broadcast_tx.subscribe();
    let settings = state.settings.get().await;
    state.broadcast_settings_updated(&settings);
    let frame = rx.recv().await.expect("a frame");
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["type"], "settings.updated");
    assert!(v["settings"].is_object());
    assert!(v["settings"].get("network").is_some());
}
```

Update the `test_state` / `test_state_with_probe_counter` helpers (`network.rs:682`, `:697`) to construct the two new fields:

```rust
let broadcast_tx = std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
let rebind = crate::net_bind::RebindController::new(0, true); // port 0: never served in unit tests
NetworkState {
    auth_token,
    settings,
    bind: Arc::new(BindState::new(bind_host)),
    port,
    facts: Arc::new(NetworkFactsCache::new()),
    probe: Arc::new(FakePortProbe::new(probe_result)),
    broadcast_tx,
    rebind,
    net_mutation: std::sync::Arc::new(tokio::sync::Mutex::new(())),
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server network::tests::broadcast 2>&1 | tail -20`
Expected: compile error (fields don't exist).

- [ ] **Step 3: Add the fields + helper**

Edit `NetworkState` (`network.rs:146-173`), adding after `probe`:

```rust
    /// The process-wide settings/event broadcast bus (same one `settings_store`
    /// uses). Network mutations broadcast `settings.updated` after the change.
    pub broadcast_tx: std::sync::Arc<tokio::sync::broadcast::Sender<String>>,
    /// The transactional rebind controller (Slice 2). Swaps the live listener
    /// between 127.0.0.1 and 0.0.0.0 without a zero-listener window.
    pub rebind: std::sync::Arc<crate::net_bind::RebindController>,
    /// Serializes ALL network mutations (configure / disable / firewall persist)
    /// from before the live-bind read through persist + bind.set — the port of
    /// the TS rebind queue (network-manager.ts:220-221, :424-436). VALIDATED
    /// (ledger A-08, reports/V5.md): without it, concurrent mutations can
    /// persist a host that contradicts the live listener.
    pub net_mutation: std::sync::Arc<tokio::sync::Mutex<()>>,
```

Add the helper method (match the `ServerSettings` path already used in `settings_store.rs`):

```rust
impl NetworkState {
    /// Emit the exact frame `settings_store::patch_settings` emits on success.
    pub fn broadcast_settings_updated(&self, settings: &crate::settings::ServerSettings) {
        if let Ok(frame) =
            serde_json::to_string(&serde_json::json!({ "type": "settings.updated", "settings": settings }))
        {
            let _ = self.broadcast_tx.send(frame);
        }
    }
}
```

- [ ] **Step 4: Wire construction in main.rs**

At `main.rs:900-907`, build the controller and extend the `NetworkState { ... }`:

```rust
let rebind = crate::net_bind::RebindController::new(port, crate::net_bind::reuse_port_enabled());
let network_state = network::NetworkState {
    auth_token: Arc::clone(&auth_token),
    settings: settings_store.clone(),
    bind: Arc::new(network::BindState::new(bind_host.clone())),
    port,
    facts: Arc::new(network::NetworkFactsCache::new()),
    probe: Arc::new(network::TcpPortProbe::default()),
    broadcast_tx: Arc::clone(&broadcast_tx),
    rebind: Arc::clone(&rebind),
    net_mutation: Arc::new(tokio::sync::Mutex::new(())),
};
```

At the serving site (`main.rs:1354-1381`), REPLACE the single `TcpListener::bind` +
`axum::serve(...).await` with controller-driven serving. After `app` is fully
built (`.merge(...)` + global `.layer(...)`):

```rust
rebind.set_app(app.clone());
let boot_ip: IpAddr = bind_host.parse().unwrap_or(IpAddr::from([127, 0, 0, 1]));
if let Err(err) = rebind.serve_on(boot_ip).await {
    eprintln!("freshell-server: failed to bind {boot_ip}:{port}: {err}");
    return ExitCode::FAILURE;
}
eprintln!(
    "freshell-server listening on http://{boot_ip}:{port} (ws://{boot_ip}:{port}/ws) [commit {}]",
    diag::build_commit()
);
shutdown_signal(Arc::clone(&shutdown_notify), std::sync::Arc::clone(&shutdown_started)).await;
rebind.shutdown_all().await;
// ... existing teardown (registry.kill_all(), *_state.shutdown(), etc.) unchanged ...
```

`shutdown_signal` is now `.await`ed directly to block `main`, then triggers the
listener drain. Preserve the existing post-serve teardown block
(`main.rs:1401-1429` — it ends at the CodexTerminalLaunchManager shutdown, not
`:1419`), KEEP the function's final `ExitCode::SUCCESS` return, and delete the
old `serve_result` error check entirely (bind failure is now the `serve_on` Err
branch above). The SIGTERM/SIGHUP exit-0 assertions in
`safe11_term22_shutdown_reaping.rs` / `sighup_forensics.rs` depend on that exit
code (VALIDATED inventory: ledger A-10, reports/V6.md — 6/6 lifecycle suites
green at the validated HEAD; no suite pins the old serving shape).

- [ ] **Step 5: Run tests + full build to verify it passes**

Run:
```
cargo test -p freshell-server network::tests::broadcast 2>&1 | tail -10
cargo build -p freshell-server 2>&1 | tail -10
```
Expected: broadcast test PASS; whole binary compiles. Fix any leftover references
to the old `serve_result` variable.

- [ ] **Step 6: Manual smoke (boot still serves)**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
cargo build --release -p freshell-server 2>&1 | tail -3
P=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
HOME=$(mktemp -d) FRESHELL_HOME=$HOME AUTH_TOKEN=verify-smoke-token-abcdef PORT=$P \
  ./target/release/freshell-server &
SRV=$!; sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$P/api/health   # expect 200
kill $SRV
```
Expected: `200`.

- [ ] **Step 7: Falsifier + commit**

```bash
grep -c 'rebind.serve_on' crates/freshell-server/src/main.rs           # must be >0
grep -c 'pub rebind:' crates/freshell-server/src/network.rs            # must be >0
grep -c 'broadcast_settings_updated' crates/freshell-server/src/network.rs  # must be >0
grep -c 'net_mutation' crates/freshell-server/src/network.rs                # must be >0 (A-08 lock present)
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs crates/freshell-server/src/main.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): wire broadcast_tx + RebindController + mutation lock into NetworkState; serve boot listener via controller`

## Task 2.2b: Boot bind honors persisted `settings.network` (restart truthfulness)

**Files:**
- Modify: `crates/freshell-server/src/main.rs:1631-1643` (`resolve_bind_host`) and its call site (`main.rs:105-106`)
- Test: `crates/freshell-server/src/network.rs` `#[cfg(test)] mod tests` (pure-helper test) + harness Phase 5 (live proof)

**Interfaces:**
- Consumes: `freshell_platform::network::{resolve_bind_host, BindHostConfig}`, `SettingsStore::get()`, `SettingsNetwork`/`NetworkHost` (`crates/freshell-protocol/src/settings.rs:112-115`, `:30-35`), `network_host_str` (`network.rs:418`).
- Produces: `pub fn boot_bind_config(network: &SettingsNetwork) -> freshell_platform::network::BindHostConfig` (in `network.rs`, pure and testable), and `main.rs` passes it instead of the hardcoded `BindHostConfig::Ok { raw_host: None, configured: false }`.

**Why:** today `resolve_bind_host()` deliberately ignores `settings.network`
(`main.rs:1638-1641`), so after a disable persists `{host:"127.0.0.1",configured:true}`,
a restart on WSL would re-bind 0.0.0.0 (the WSL default) — re-exposing a server
the user retracted, and failing harness Phase 5 (tier-b must stay REFUSED across
restart). **Depends on Task 0.3** — VALIDATED (ledger A-04, reports/V2.md): at
the pre-plan HEAD the platform function returned the WSL default BEFORE
consulting config (`network.rs:57-59`), so this task alone could never pass
Phase 5. With Task 0.3 landed the precedence is: explicit `FRESHELL_BIND_HOST`
→ persisted config (when `configured: true`) → WSL default `0.0.0.0` → `HOST`
env → `127.0.0.1`; this task's only job is to feed the REAL persisted config in.
Also update the `resolve_bind_host` doc comment in `main.rs:1621-1630` to match.

- [ ] **Step 1: Write the failing test**

In `network.rs` tests:

```rust
#[test]
fn boot_bind_config_passes_persisted_network_intent() {
    use freshell_platform::network::BindHostConfig;
    let net = crate::settings::SettingsNetwork {
        configured: true,
        host: crate::settings::NetworkHost::Loopback,
    };
    match boot_bind_config(&net) {
        BindHostConfig::Ok { raw_host, configured } => {
            assert_eq!(raw_host.as_deref(), Some("127.0.0.1"));
            assert!(configured);
        }
        _ => panic!("expected Ok config"),
    }
    let unconfigured = crate::settings::SettingsNetwork {
        configured: false,
        host: crate::settings::NetworkHost::Loopback,
    };
    match boot_bind_config(&unconfigured) {
        BindHostConfig::Ok { raw_host, configured } => {
            // unconfigured: still pass the host as a raw hint but configured=false,
            // so the WSL default / HOST env keep their precedence.
            assert_eq!(raw_host.as_deref(), Some("127.0.0.1"));
            assert!(!configured);
        }
        _ => panic!("expected Ok config"),
    }
}
```

(Match the exact `SettingsNetwork`/`NetworkHost` paths used elsewhere in
`network.rs`; adjust the `BindHostConfig` variant fields to the real enum at
`crates/freshell-platform/src/network.rs:22` — read it first.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server network::tests::boot_bind_config 2>&1 | tail -10`
Expected: compile error — helper absent.

- [ ] **Step 3: Implement the helper + wire it into main**

In `network.rs`:

```rust
/// Boot-time bind config from the persisted settings (NET-02/06 restart
/// truthfulness): a disable that persisted loopback must survive a restart.
pub fn boot_bind_config(
    network: &crate::settings::SettingsNetwork,
) -> freshell_platform::network::BindHostConfig {
    freshell_platform::network::BindHostConfig::Ok {
        raw_host: Some(network_host_str(&network.host).to_string()),
        configured: network.configured,
    }
}
```

In `main.rs`, the bind host must now be resolved AFTER the settings store loads.
Move the `let bind_host = resolve_bind_host();` call (currently `main.rs:105-106`)
to after `settings_store` is constructed, and change `resolve_bind_host`
(`main.rs:1631-1643`) to take the persisted network settings:

```rust
fn resolve_bind_host(network: &freshell_protocol::settings::SettingsNetwork) -> String {
    let is_wsl = is_wsl_proc(read_proc_version().as_deref());
    freshell_platform::network::resolve_bind_host(
        &freshell_platform::RealEnv,
        is_wsl,
        network::boot_bind_config(network),
    )
}
```

Call site: `let bind_host = resolve_bind_host(&settings_store.get().await.network);`
(match the async context main already has). Keep the env precedence intact — the
platform function already orders `FRESHELL_BIND_HOST` above the config.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5`
Expected: green (the platform precedence tests — including Task 0.3's two new
ones — still pass; the new helper test passes). Harness Phase 5 (Task 5.3) is the
live proof: after disable + restart, tier (b) stays REFUSED.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c 'raw_host: None' crates/freshell-server/src/main.rs        # must be 0
grep -c 'boot_bind_config' crates/freshell-server/src/network.rs   # must be >0
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs crates/freshell-server/src/main.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): boot bind honors persisted settings.network (restart truthfulness)`

## Task 2.3: `POST /api/network/configure` — transactional expose/rebind

**Files:**
- Modify: `crates/freshell-server/src/network.rs` — add `use axum::routing::post;`, add route to `router()` (`:265-270`), add `configure` handler + `NetworkConfigureRequest`
- Test: `crates/freshell-server/src/network.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `NetworkState.rebind`, `.settings` (`patch`), `.bind` (`get`/`set`), `.facts` (`invalidate`), `.broadcast_settings_updated`, `build_network_status`, `is_authed`/`unauthorized`.
- Produces: route `POST /api/network/configure`; handler `async fn configure(State<NetworkState>, HeaderMap, Option<Json<Value>>) -> Response`; a reusable `async fn build_status_value(state: &NetworkState) -> Value`; a `fn invalid_request(details: Value) -> Response`.

**Behavior (ordered — matches `network-router.ts:431-446` + `network-manager.ts:400-439`, with the NET-02 transactional fix):**

1. Auth → 401 `{"error":"Unauthorized"}`.
2. Parse body into the enum-typed request. Failure → **400 `{"error":"Invalid request","details":[...]}`**. `host` accepts ONLY `"127.0.0.1"`/`"0.0.0.0"` (decoded into a Rust enum — the NET-08 arbitrary-host defense made structural). Schema is NON-strict (unknown keys ignored, matching `NetworkConfigureSchema`).
3. Acquire `state.net_mutation.lock().await` and hold the guard through step 6 (A-08 serialization — the TS serialized rebinds via its `pendingRebindConfig` queue; we serialize via one mutex). Then compute `host_changed` from the LIVE bind (`BindState::get()`). **DEVIATION (ledgered, Task 6.1 #7):** the TS forces `host_changed=false` on wsl2 (`network-manager.ts:412-413`) because its WSL exposure rides Windows portproxy and the listener always stays on 0.0.0.0. Our port binds truthfully on every platform, and the tier-b bind-address truth test plus the NET-06 disable (which really rebinds to loopback on this WSL2 host) require the symmetric re-expose to really rebind too — so wsl2 rebinds like every other platform.
4. If `host_changed`: `rebind.serve_on(new_ip)` — binds+proves the new listener FIRST. On `Err` → **500 `{"error":"Failed to configure network"}`, nothing persisted, old listener untouched**.
5. Persist `{network:{host, configured}}` via `settings.patch(...)` (NET-09 rides the store; no new writer). On patch error: if the listener was already swapped (`host_changed`), ROLL IT BACK with `rebind.serve_on(old_ip)` BEFORE propagating `(status, body)` — persisted state must never outrun reality (NET-02); the frozen TS has the mirror-image revert (`network-manager.ts:474-505`). If the rollback bind itself fails, keep status truthful anyway (`bind.set(new_host)`) and log a CATASTROPHIC error. Either way `facts.invalidate()` before returning the error.
6. `facts.invalidate()`, `bind.set(new_host)`.
7. Build settled status, respond `{...status, "rebindScheduled": false}`.
8. AFTER responding, broadcast `settings.updated` with the full merged tree.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn configure_to_all_interfaces_persists_and_reports_settled_host() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;
    let state = test_state("127.0.0.1", Some(true));
    seed_facts(&state, vec!["192.168.3.50".into()], linux_none_inactive()).await;
    let resp = router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/network/configure")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"host":"0.0.0.0","configured":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["host"], "0.0.0.0");
    assert_eq!(body["configured"], true);
    assert_eq!(body["rebindScheduled"], false);
    let s = state.settings.get().await;
    assert_eq!(serde_json::to_value(&s.network).unwrap()["host"], "0.0.0.0");
}

#[tokio::test]
async fn configure_rejects_arbitrary_host_with_400() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;
    let state = test_state("127.0.0.1", None);
    for bad in [r#"{"host":"10.0.0.1","configured":true}"#,
                r#"{"host":"0.0.0.0; rm -rf /","configured":true}"#,
                r#"{"host":"$(id)","configured":true}"#,
                r#"{"configured":true}"#,
                r#"{"host":"0.0.0.0","configured":"yes"}"#] {
        let resp = router(state.clone())
            .oneshot(Request::builder().method("POST").uri("/api/network/configure")
                .header("x-auth-token","tok").header("content-type","application/json")
                .body(Body::from(bad)).unwrap()).await.unwrap();
        assert_eq!(resp.status(), 400, "payload {bad} must be rejected");
        let body = body_json(resp).await;
        assert_eq!(body["error"], "Invalid request");
        assert!(body["details"].is_array());
    }
}

#[tokio::test]
async fn configure_requires_auth() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;
    let state = test_state("127.0.0.1", None);
    let resp = router(state)
        .oneshot(Request::builder().method("POST").uri("/api/network/configure")
            .header("content-type","application/json")
            .body(Body::from(r#"{"host":"0.0.0.0","configured":true}"#)).unwrap())
        .await.unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn configure_rolls_back_the_listener_when_persist_fails() {
    // NET-02 falsifier (Task 6.1 #9): a persist failure AFTER a successful swap
    // must roll the LISTENER back so reality keeps matching the (unchanged)
    // persisted config and BindState. Detector: a 127.0.0.1-bound listener
    // rejects connects to 127.0.0.2; a 0.0.0.0-bound one accepts them.
    // Persist failure is forced through the store's own error path: a
    // file-backed settings store under a HOME whose .freshell dir is read-only.
    // FIRST read settings_store.rs and confirm persist errors propagate out of
    // SettingsStore::patch as Err((status, body)); if they are swallowed today,
    // make them propagate in this task (load-bearing for NET-02/NET-09).
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".freshell")).unwrap();
    let state = test_state_with_home("127.0.0.1", Some(true), home.path());
    seed_facts(&state, vec!["192.168.3.50".into()], linux_none_inactive()).await;
    let port = serve_real_test_app_on_loopback(&state).await;
    let mut perms = std::fs::metadata(home.path().join(".freshell")).unwrap().permissions();
    perms.set_mode(0o555); // read-only dir => the atomic tmp+rename persist fails
    std::fs::set_permissions(home.path().join(".freshell"), perms).unwrap();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/configure")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from(r#"{"host":"0.0.0.0","configured":true}"#)).unwrap())
        .await.unwrap();
    assert!(resp.status().is_server_error(), "persist failure must surface");
    // Rollback proof: the wildcard listener must be GONE (127.0.0.2 refused),
    // loopback still serves, and neither BindState nor settings claim 0.0.0.0.
    assert!(tokio::net::TcpStream::connect(("127.0.0.2", port)).await.is_err(),
        "listener left on 0.0.0.0 after failed persist (no rollback)");
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok());
    assert_eq!(state.bind.get().await, "127.0.0.1");
    let s = state.settings.get().await;
    assert_eq!(serde_json::to_value(&s.network).unwrap()["host"], "127.0.0.1");
}
```

These unit tests exercise persistence + validation + wire shape without a live
listener: `test_state`'s controller has no app injected, so `serve_on` returns
`Ok(())` immediately (the seam added in Task 2.1). Real bind-address truth is
proven by the harness at tier b (Task 5.2). The EXCEPTION is the rollback test,
which needs a real listener and a file-backed store. Add two small test helpers
next to `test_state`: `test_state_with_home(host, configured, home)` — identical
to `test_state` but its settings store persists under `home` — and
`async fn serve_real_test_app_on_loopback(&state) -> u16` — constructs the
state's `RebindController` on an ephemeral free port, injects the same hello
`Router` Task 2.1's tests use (`set_app`), calls `serve_on(127.0.0.1)`, and
returns the port.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server network::tests::configure 2>&1 | tail -20`
Expected: 404/compile — route/handler absent.

- [ ] **Step 3: Implement the route + handler**

Add `use axum::routing::post;`. Register the route:

```rust
pub fn router(state: NetworkState) -> Router {
    Router::new()
        .route("/api/network/status", get(network_status))
        .route("/api/lan-info", get(lan_info))
        .route("/api/network/configure", post(configure))
        .with_state(state)
}
```

Add the typed request + a zod-shaped 400 helper:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConfigureRequest {
    host: crate::settings::NetworkHost, // enum: only "127.0.0.1" | "0.0.0.0" deserialize
    configured: bool,
}

fn invalid_request(details: serde_json::Value) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": "Invalid request", "details": details })),
    )
        .into_response()
}
```

Handler:

```rust
async fn configure(
    State(state): State<NetworkState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let raw = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let req: NetworkConfigureRequest = match serde_json::from_value(raw) {
        Ok(r) => r,
        Err(e) => {
            return invalid_request(json!([{
                "code": "invalid_type", "path": [], "message": e.to_string()
            }]));
        }
    };
    // A-08: serialize all network mutations — held through persist + bind.set.
    let _mutation_guard = state.net_mutation.lock().await;
    let new_host = network_host_str(&req.host).to_string(); // "127.0.0.1" | "0.0.0.0"
    let live_host = state.bind.get().await;
    // DEVIATION (Task 6.1 #7): no wsl2 exception — our bind is truthful on every
    // platform, so wsl2 rebinds for real (the TS kept its listener on 0.0.0.0 and
    // used portproxy for exposure; network-manager.ts:412-413).
    let host_changed = live_host != new_host;

    if host_changed {
        let new_ip: std::net::IpAddr = new_host.parse().expect("enum guarantees a valid IP literal");
        if state.rebind.serve_on(new_ip).await.is_err() {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Failed to configure network" })),
            ).into_response();
        }
    }

    // Persist AFTER the new listener is proven (NET-02).
    let patch = json!({ "network": { "host": new_host, "configured": req.configured } });
    let merged = match state.settings.patch(&patch).await {
        Ok(m) => m,
        Err((status, body)) => {
            // Persist failed AFTER the live swap: roll the LISTENER back so
            // reality re-matches the (unchanged) persisted config + BindState
            // (NET-02 "persisted state never outruns reality"; the frozen TS
            // revert is network-manager.ts:474-505).
            if host_changed {
                let old_ip: std::net::IpAddr = live_host
                    .parse()
                    .expect("BindState only ever holds enum-validated IP literals");
                if state.rebind.serve_on(old_ip).await.is_err() {
                    // Rollback bind failed: the live listener stays on new_host.
                    // Keep status TRUTHFUL anyway and log loudly; the persisted
                    // file is stale until the next successful mutation.
                    state.bind.set(new_host.clone()).await;
                    tracing::error!(
                        "CATASTROPHIC: persist failed and rollback rebind failed; \
                         live listener on {new_host} contradicts persisted config"
                    );
                }
                state.facts.invalidate().await;
            }
            return (status, Json(body)).into_response();
        }
    };
    state.facts.invalidate().await;
    if host_changed {
        state.bind.set(new_host.clone()).await;
    }

    let mut out = build_status_value(&state).await;
    out["rebindScheduled"] = json!(false);
    let response = (axum::http::StatusCode::OK, Json(out)).into_response();
    state.broadcast_settings_updated(&merged);
    response
}
```

Refactor the status-building block currently inline in `network_status`
(`network.rs:286-329`) into `async fn build_status_value(state: &NetworkState) -> Value`
and call it from BOTH `network_status` and `configure` (DRY — do not duplicate the
probe/facts logic).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server network::tests 2>&1 | tail -20`
Expected: the four new `configure_*` tests PASS (rollback test included); all Slice-1 route tests still PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c '"/api/network/configure"' crates/freshell-server/src/network.rs   # must be >0
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): POST /api/network/configure with transactional rebind (NET-02/09)`

## Task 2.4: `POST /api/network/disable-remote-access` — Linux-live retract

**Files:**
- Modify: `crates/freshell-server/src/network.rs` — add route + `disable_remote_access` handler + strict `ConfirmFirewallRequest` (shared with Slice 3) + a `DisableNone` enum
- Test: `crates/freshell-server/src/network.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: same as Task 2.3, plus `is_remote_access_enabled` (freshell-platform network), `is_wsl_port_forwarding_disabled_by_env`.
- Produces: route `POST /api/network/disable-remote-access`; a `#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] pub(crate) struct ConfirmFirewallRequest { confirm_elevation: Option<bool>, confirmation_token: Option<String> }` (strict; `confirm_elevation != Some(false)`; `confirmation_token` non-empty when present).

**Behavior (matches `network-router.ts:448-615` + `applyRemoteAccessDisabledState` `:119-132`, Linux lane; Windows/WSL2 lanes return placeholder confirmation data here WITHOUT elevating — the full gate-issued protocol lands in Task 3.3, which REPLACES that placeholder; only the live elevated side effect is HOST-BLOCKED):**

1. Auth → 401.
2. Strict-parse → 400 on unknown key / `confirmElevation:false` / empty `confirmationToken`.
3. (409 in-flight lock pre-check added in Task 3.3 when the gate is wired.)
4. Acquire `state.net_mutation.lock().await` (held through the rebind + persist — A-08), then resolve the disable action from the live platform:
   - **Native Linux / macOS (this host's non-WSL path):** `{method:"none", message:...}`; when remote access WAS requested, apply the disabled state (rebind to `127.0.0.1` + persist `{host:"127.0.0.1",configured:true}` + broadcast). This IS the live retract (NET-06). If the persist fails AFTER the loopback swap: FAIL-SAFE — never re-expose on an error path; keep the loopback listener, `bind.set("127.0.0.1")` so status reports reality, `facts.invalidate()`, and propagate the error (ledgered deviation, Task 6.1 #9).
   - **WSL2 with `FRESHELL_DISABLE_WSL_PORT_FORWARD=1`:** same Linux path (deterministic, zero `netsh`). Otherwise return the `confirmation-required` body WITHOUT elevating (HOST-BLOCKED). Never elevate here.
5. Message strings are the control signal — EXACT constants (`network-router.ts:40-48`), modeled as an enum discriminant, not a free string:
   - `"Remote access is not enabled"` / `"Remote access disabled"`.
6. The success response is emitted AFTER the drain (verified teardown, NET-06).

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn disable_from_exposed_linux_rebinds_to_loopback_and_persists() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state("0.0.0.0", Some(true));
    seed_facts(&state, vec!["192.168.3.50".into()], linux_none_inactive()).await;
    let _ = state.settings.patch(&serde_json::json!({"network":{"host":"0.0.0.0","configured":true}})).await.unwrap();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "none");
    assert_eq!(body["message"], "Remote access disabled");
    let s = state.settings.get().await;
    assert_eq!(serde_json::to_value(&s.network).unwrap()["host"], "127.0.0.1");
}

#[tokio::test]
async fn disable_rejects_unknown_keys_strictly() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state("127.0.0.1", None);
    let resp = router(state)
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from(r#"{"unknownKey":1}"#)).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn disable_requires_auth() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state("127.0.0.1", None);
    let resp = router(state)
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("content-type","application/json").body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn concurrent_configure_and_disable_serialize_to_a_consistent_end_state() {
    // Falsifier for the A-08 mutation lock: without net_mutation held across
    // bind.get() -> bind.set(), interleavings persist a host that contradicts
    // the live bind (concrete counterexample schedules in reports/V5.md).
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state("0.0.0.0", Some(true));
    seed_facts(&state, vec!["192.168.3.50".into()], linux_none_inactive()).await;
    let cfg = router(state.clone()).oneshot(Request::builder().method("POST")
        .uri("/api/network/configure").header("x-auth-token","tok")
        .header("content-type","application/json")
        .body(Body::from(r#"{"host":"0.0.0.0","configured":true}"#)).unwrap());
    let dis = router(state.clone()).oneshot(Request::builder().method("POST")
        .uri("/api/network/disable-remote-access").header("x-auth-token","tok")
        .header("content-type","application/json")
        .body(Body::from("{}")).unwrap());
    let (r1, r2) = tokio::join!(cfg, dis);
    assert_eq!(r1.unwrap().status(), 200);
    assert_eq!(r2.unwrap().status(), 200);
    // Whichever order the lock imposed, persisted host must equal the live bind.
    let persisted = serde_json::to_value(&state.settings.get().await.network).unwrap()["host"].clone();
    let live = state.bind.get().await;
    assert_eq!(persisted, serde_json::json!(live),
        "persisted host desynced from live bind (A-08)");
}

#[tokio::test]
async fn disable_keeps_loopback_and_reports_error_when_persist_fails() {
    // FAIL-SAFE counterpart of Task 2.3's rollback test (Task 6.1 #9): when the
    // persist fails AFTER the loopback swap, disable must NOT roll back toward
    // exposure — loopback listener kept, BindState truthful, error surfaced.
    // Same read-only-.freshell persist-failure injection and test_state_with_home
    // helper as Task 2.3.
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".freshell")).unwrap();
    let state = test_state_with_home("0.0.0.0", Some(true), home.path());
    seed_facts(&state, vec!["192.168.3.50".into()], linux_none_inactive()).await;
    let _ = state.settings.patch(&serde_json::json!({"network":{"host":"0.0.0.0","configured":true}})).await.unwrap();
    let mut perms = std::fs::metadata(home.path().join(".freshell")).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(home.path().join(".freshell"), perms).unwrap();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    assert!(resp.status().is_server_error(), "persist failure must surface");
    // Truthful + fail-safe: BindState reports the loopback reality; only the
    // persisted file is stale (and the client got an error saying so).
    assert_eq!(state.bind.get().await, "127.0.0.1");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server network::tests::disable 2>&1 | tail -20`
Expected: 404/compile — route absent.

- [ ] **Step 3: Implement the strict request type, the enum, the route + handler**

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfirmFirewallRequest {
    pub confirm_elevation: Option<bool>,
    pub confirmation_token: Option<String>,
}

impl ConfirmFirewallRequest {
    fn validate(&self) -> Result<(), Response> {
        if matches!(self.confirm_elevation, Some(false)) {
            return Err(invalid_request(json!([{"code":"invalid_literal","path":["confirmElevation"],"message":"Expected true"}])));
        }
        if matches!(self.confirmation_token.as_deref(), Some("")) {
            return Err(invalid_request(json!([{"code":"too_small","path":["confirmationToken"],"message":"String must contain at least 1 character(s)"}])));
        }
        Ok(())
    }
}

enum DisableNone { NotEnabled, Disabled }
impl DisableNone {
    fn message(&self) -> &'static str {
        match self { DisableNone::NotEnabled => "Remote access is not enabled",
                     DisableNone::Disabled => "Remote access disabled" }
    }
}
```

Register `.route("/api/network/disable-remote-access", post(disable_remote_access))` and:

```rust
async fn disable_remote_access(
    State(state): State<NetworkState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let raw = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let req: ConfirmFirewallRequest = match serde_json::from_value(raw) {
        Ok(r) => r,
        Err(e) => return invalid_request(json!([{"code":"unrecognized_keys","path":[],"message":e.to_string()}])),
    };
    if let Err(resp) = req.validate() { return resp; }

    // (Slice 3 inserts the 409 in-flight lock pre-check here.)

    // A-08: serialize all network mutations — held through persist + bind.set.
    let _mutation_guard = state.net_mutation.lock().await;

    let facts = state.facts.get_or_refresh().await;
    let platform = facts.firewall.platform;
    let settings = state.settings.get().await;
    // `requested` uses the exact is_remote_access_enabled inputs Slice 1 uses in
    // build_status_value (read network.rs around :325/:357 and reuse them).
    let requested = compute_remote_access_requested(&settings, &state.bind.get().await, platform);

    let wsl_forwarding_disabled =
        freshell_platform::port_forward::is_wsl_port_forwarding_disabled_by_env(&freshell_platform::RealEnv);
    let is_live_linux_lane = platform != FirewallPlatform::Windows
        && (platform != FirewallPlatform::Wsl2 || wsl_forwarding_disabled);

    if is_live_linux_lane {
        if requested {
            // VALIDATED (ledger A-09, reports/V1.md): a foreign non-reuseport
            // squatter on the port makes this bind fail (EADDRINUSE) — never
            // claim a retract that did not happen.
            if state.rebind.serve_on(std::net::IpAddr::from([127, 0, 0, 1])).await.is_err() {
                return (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Failed to disable remote access" })),
                ).into_response();
            }
            let merged = match state.settings
                .patch(&json!({"network":{"host":"127.0.0.1","configured":true}})).await {
                Ok(m) => m,
                Err((s, b)) => {
                    // Persist failed AFTER the loopback swap. FAIL-SAFE: never
                    // roll back toward exposure on an error path — keep the
                    // loopback listener, make status truthful, surface the
                    // error (deviation from the TS revert-persist; Task 6.1 #9).
                    state.bind.set("127.0.0.1").await;
                    state.facts.invalidate().await;
                    return (s, Json(b)).into_response();
                }
            };
            state.facts.invalidate().await;
            state.bind.set("127.0.0.1").await;
            let resp = (axum::http::StatusCode::OK,
                Json(json!({"method":"none","message":DisableNone::Disabled.message()}))).into_response();
            state.broadcast_settings_updated(&merged);
            return resp;
        }
        return (axum::http::StatusCode::OK,
            Json(json!({"method":"none","message":DisableNone::NotEnabled.message()}))).into_response();
    }

    // Windows or WSL2-needing-elevation: TEMPORARY Slice-2 placeholder. The
    // token below is throwaway (NOT stored in any gate) and MUST NOT survive
    // Slice 3: Task 3.3 REPLACES this whole block with the gate-issued,
    // action-bound confirmation + confirmed-dispatch flow (windows-disable /
    // wsl2-disable lanes). Only the live elevated side effect stays
    // HOST-BLOCKED (Task 3.6).
    (axum::http::StatusCode::OK, Json(json!({
        "method":"confirmation-required",
        "title":"Administrator approval required",
        "body":"To complete this, you will need to accept the Windows administrator prompt on the next screen.",
        "confirmLabel":"Continue",
        "confirmationToken": uuid::Uuid::new_v4().to_string()
    }))).into_response()
}
```

Extract `compute_remote_access_requested` from the Slice-1 status code (or inline
the same `is_remote_access_enabled(...)` call with identical inputs) so the two
never diverge.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server network::tests 2>&1 | tail -20`
Expected: the four new `disable_*` tests PASS (persist-failure fail-safe included); all prior tests PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c '"/api/network/disable-remote-access"' crates/freshell-server/src/network.rs  # must be >0
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): POST /api/network/disable-remote-access — live Linux retract (NET-06)`

## Task 2.5: NET-09 byte-preservation across a network mutation + restart (black-box)

**Files:**
- Create: `crates/freshell-server/tests/net09_config_preservation.rs`

**Interfaces:**
- Consumes: the compiled `freshell-server` binary; harness helpers copied from `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs:37-108` (with an attribution comment, as `sighup_forensics.rs` does): `discover_server_binary`, `allocate_ephemeral_port`, `wait_for_health`.
- Produces: a `#![cfg(unix)]` black-box test proving unmanaged top-level config keys survive a network mutation and a restart byte-for-byte.

- [ ] **Step 1: Write the failing test**

Create `crates/freshell-server/tests/net09_config_preservation.rs`:

```rust
#![cfg(unix)]
//! NET-09: a network mutation must route through the serialized config store and
//! leave every unrelated top-level document key byte-identical, across restart.
//! Harness helpers copied from safe11_term22_shutdown_reaping.rs (attribution).

use std::process::Command;
use std::time::Duration;

const AUTH_TOKEN: &str = "net09-preservation-token-abcdef012345";

// --- copy discover_server_binary / allocate_ephemeral_port / wait_for_health here ---

fn sha256_hex(bytes: &[u8]) -> String {
    // use the sha2 dev-dep, or shell out to `sha256sum`.
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

#[tokio::test]
async fn network_mutation_preserves_every_unmanaged_top_level_key() {
    let home = tempfile::tempdir().unwrap();
    let seed = serde_json::json!({
        "version": 1,
        "settings": { "network": { "host": "127.0.0.1", "configured": false } },
        "sessionOverrides": { "SENTINEL_SESSION": { "keep": "me" } },
        "terminalOverrides": { "SENTINEL_TERM": { "keep": "me" } },
        "serverSecrets": { "SENTINEL_SECRET": "do-not-touch" },
        "completedMigrations": ["m-001", "m-002"],
        "recentDirectories": ["/tmp/a", "/tmp/b"],
        "projectColors": { "/tmp/a": "#123456" },
        "someUnknownFutureKey": { "arbitrary": [1, 2, 3] }
    });
    let cfg_dir = home.path().join(".freshell");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(cfg_dir.join("config.json"), serde_json::to_vec_pretty(&seed).unwrap()).unwrap();

    let orig: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_dir.join("config.json")).unwrap()).unwrap();
    let watched = ["sessionOverrides","terminalOverrides","serverSecrets",
                   "completedMigrations","recentDirectories","projectColors","someUnknownFutureKey"];
    let before: std::collections::HashMap<_, _> = watched.iter()
        .map(|k| (*k, sha256_hex(&serde_json::to_vec(&orig[*k]).unwrap()))).collect();

    let port = allocate_ephemeral_port();
    let bin = discover_server_binary();
    let mut child = Command::new(&bin)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("FRESHELL_DISABLE_WSL_PORT_FORWARD", "1")
        .spawn().unwrap();
    assert!(wait_for_health(port, &mut child, Duration::from_secs(20)).await);

    let client = reqwest::Client::new();
    let resp = client.post(format!("http://127.0.0.1:{port}/api/network/configure"))
        .header("x-auth-token", AUTH_TOKEN)
        .json(&serde_json::json!({"host":"0.0.0.0","configured":true}))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // ownership-verified SIGTERM (check /proc/<pid>/cwd + cmdline before signaling).
    let pid = child.id();
    unsafe { libc::kill(pid as i32, libc::SIGTERM); }
    let _ = child.wait();

    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(after["settings"]["network"]["host"], "0.0.0.0");
    assert_eq!(after["settings"]["network"]["configured"], true);
    for k in watched {
        let now = sha256_hex(&serde_json::to_vec(&after[k]).unwrap());
        assert_eq!(before[k], now, "top-level key `{k}` was not byte-preserved");
    }
}
```

`sha2` 0.10 is already a `freshell-server` dependency (usable from tests).
`libc` is already present under `[target.'cfg(unix)'.dependencies]` (VALIDATED,
reports/V7.md).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server --test net09_config_preservation 2>&1 | tail -30`
Expected: fails to compile until helpers are copied; then GREEN on top of Task
2.3 (if it fails, fix the endpoint, not the test).

- [ ] **Step 3: Make it pass** — copy helpers, ensure the binary builds.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-server --test net09_config_preservation 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
test -f crates/freshell-server/tests/net09_config_preservation.rs && echo present
cargo test -p freshell-server --test net09_config_preservation 2>&1 | tail -5
cargo clippy -p freshell-server --tests -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/tests/net09_config_preservation.rs crates/freshell-server/Cargo.toml
git commit  # paste falsifier output
```

Commit message: `test(net): NET-09 byte-preservation of unmanaged config across mutation + restart`

---

# SLICE 3 — configure-firewall + Windows/WSL2 machinery behind fakes

Blocked on Slice 0 (do not start until `grep -c 'c\.token == t' elevated.rs` is 0
and `wsl_ip: &str` is gone). All OS mutation flows through the injected
`CommandRunner`; the real Windows-mutation runner is a `#[cfg(windows)]`-only enum
variant, so on this Linux host it is structurally unreachable. NET-04/05/07 are
HOST-BLOCKED and evidenced by golden/fake tests + a compile-time unreachability
proof; the endpoint's confirmation-token protocol and 409 lock ARE exercised live
by the harness (Task 5.4).

## Task 3.1: `ElevationRunner` enum — structural unreachability of real OS mutation

**Files:**
- Modify: `crates/freshell-platform/src/elevated.rs`
- Test: `crates/freshell-platform/src/elevated.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub enum ElevationRunner<'a> { Fake(&'a dyn crate::CommandRunner), #[cfg(windows)] Real, Unsupported }` — the real, process-spawning variant exists ONLY under `#[cfg(windows)]`.
  - `pub fn elevation_runner_live() -> ElevationRunner<'static>` — `Real` under `#[cfg(windows)]`, `Unsupported` otherwise (cannot construct `Real` off Windows).
  - `pub fn spawn_via(runner: &ElevationRunner<'_>, command: &str, script: &str) -> ElevationOutcome`.
  - `pub enum ElevationOutcome { Started, Denied, TimedOut, PartialFailure, VerificationFailed, NotSupported }`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn on_non_windows_the_live_runner_is_unsupported_and_never_spawns() {
    #[cfg(not(windows))]
    {
        let runner = elevation_runner_live();
        assert!(matches!(runner, ElevationRunner::Unsupported));
        let out = spawn_via(&runner, "powershell.exe", "netsh advfirewall firewall add rule ...");
        assert_eq!(out, ElevationOutcome::NotSupported);
    }
}

#[test]
fn source_only_constructs_real_under_cfg_windows() {
    // Needles are concat!-split so this test's OWN source never satisfies the
    // contains() checks -- the assertions genuinely inspect the implementation
    // code elsewhere in this file instead of passing vacuously.
    let src = include_str!("elevated.rs");
    let cfg_gate = concat!("#[cfg(", "windows)]");
    let unsupported = concat!("ElevationRunner::", "Unsupported");
    assert!(src.contains(cfg_gate), "the Real elevation runner must be cfg(windows)-gated");
    assert!(src.contains(unsupported), "Unsupported variant missing from elevated.rs");
}

#[test]
fn fake_runner_dispatch_classifies_outcomes() {
    use crate::{FakeCommandRunner, CommandOutput};
    let denied = FakeCommandRunner::new().with_default(
        CommandOutput::failure(1, "", "The operation was canceled by the user"));
    let out = spawn_via(&ElevationRunner::Fake(&denied), "powershell.exe", "script");
    assert_eq!(out, ElevationOutcome::Denied);
    let ok = FakeCommandRunner::new().with_default(CommandOutput::success(""));
    let out = spawn_via(&ElevationRunner::Fake(&ok), "powershell.exe", "script");
    assert_eq!(out, ElevationOutcome::Started);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-platform elevated::tests::on_non_windows 2>&1 | tail -20`
Expected: compile error — types absent.

- [ ] **Step 3: Implement the enum + dispatcher + classification**

```rust
#[derive(Debug, PartialEq, Eq)]
pub enum ElevationOutcome {
    Started,
    Denied,
    TimedOut,
    PartialFailure,
    VerificationFailed,
    NotSupported,
}

pub enum ElevationRunner<'a> {
    /// Test/injected path — dispatches through a CommandRunner fake.
    Fake(&'a dyn crate::CommandRunner),
    /// Real elevation. EXISTS ONLY on Windows: on this Linux host the live
    /// constructor cannot produce this variant, so real netsh mutation is
    /// structurally unreachable (safety satisfied by the type system).
    #[cfg(windows)]
    Real,
    /// Non-Windows host: elevation is not supported and never spawns.
    Unsupported,
}

pub fn elevation_runner_live() -> ElevationRunner<'static> {
    #[cfg(windows)]
    { ElevationRunner::Real }
    #[cfg(not(windows))]
    { ElevationRunner::Unsupported }
}

fn classify(out: &crate::CommandOutput) -> ElevationOutcome {
    let text = format!("{} {}", out.stdout, out.stderr).to_ascii_lowercase();
    if text.contains("canceled by the user") || text.contains("cancelled") {
        return ElevationOutcome::Denied;
    }
    if out.ok() { ElevationOutcome::Started } else { ElevationOutcome::Denied }
}

pub fn spawn_via(runner: &ElevationRunner<'_>, command: &str, script: &str) -> ElevationOutcome {
    match runner {
        ElevationRunner::Fake(r) => classify(&spawn_elevated_powershell(*r, command, script)),
        #[cfg(windows)]
        ElevationRunner::Real => {
            classify(&spawn_elevated_powershell(&crate::StdCommandRunner::default(), command, script))
        }
        ElevationRunner::Unsupported => ElevationOutcome::NotSupported,
    }
}
```

(`spawn_elevated_powershell(runner, command, script)` exists at `elevated.rs:37`.
Timeout/partial/verification-failed outcomes are produced by the caller in Task
3.3/3.5 by re-running the verifier plan; `classify` distinguishes started vs
denied.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-platform elevated:: 2>&1 | tail -20`
Expected: all new + existing PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c '#\[cfg(windows)\]' crates/freshell-platform/src/elevated.rs   # must be >0
grep -c 'ElevationRunner::Unsupported' crates/freshell-platform/src/elevated.rs  # must be >0
cargo test -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-platform/src/elevated.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): ElevationRunner enum — real OS mutation structurally unreachable off Windows`

## Task 3.2: Managed-remote-access-ports persistence module (instance-scoped, fake-backed)

**Files:**
- Create: `crates/freshell-server/src/managed_ports.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod managed_ports;`)
- Test: `crates/freshell-server/src/managed_ports.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Produces (port of `network-manager.ts:66-137` + `wsl-port-forward.ts:59-219`, with D15/D16 fixed — honour `FRESHELL_HOME`, atomic write, instance-scoped by `sha256(cwd::port)`):
  - `pub struct ManagedPortsStore { home: Option<PathBuf>, cwd: PathBuf, port: u16 }`
  - `pub fn windows(home: Option<PathBuf>, cwd: PathBuf, port: u16) -> Self`
  - `pub fn read_windows(&self) -> Vec<u16>` / `pub fn persist_windows(&self, ports: &[u16]) -> std::io::Result<()>` / `pub fn clear_windows(&self) -> std::io::Result<()>`
  - equivalent WSL methods keyed the same way.
  - Normalization: dedupe, keep `[1,65535]`, ascending sort. Empty list ⇒ delete the file.
  - Path: `<home|~>/.freshell/windows-managed-remote-access-ports/<sha256("{cwd}::{port}")>.json`, content `{"ports":[...]}` pretty (2-space), atomic tmp+rename.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persist_read_roundtrip_and_normalization() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        store.persist_windows(&[3001, 3001, 70000, 8080, 0]).unwrap();
        assert_eq!(store.read_windows(), vec![3001, 8080]);
    }
    #[test]
    fn empty_list_deletes_the_file() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        store.persist_windows(&[3001]).unwrap();
        store.persist_windows(&[]).unwrap();
        assert!(store.read_windows().is_empty());
    }
    #[test]
    fn two_instances_do_not_clobber_each_other() {
        let home = tempfile::tempdir().unwrap();
        let a = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        let b = ManagedPortsStore::windows(Some(home.path().into()), "/proj/b".into(), 3001);
        a.persist_windows(&[3001]).unwrap();
        b.persist_windows(&[4001]).unwrap();
        assert_eq!(a.read_windows(), vec![3001]);
        assert_eq!(b.read_windows(), vec![4001]);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server managed_ports:: 2>&1 | tail -20`
Expected: compile error.

- [ ] **Step 3: Implement the module**

Write `ManagedPortsStore` with `sha256` keying (use the `sha2` 0.10 crate
already in `[dependencies]` — VALIDATED, reports/V7.md), atomic tmp+rename
(`.tmp-<pid>-<nanos>` then `std::fs::rename`), and the normalization rule. The WSL
methods mirror the Windows ones under a `wsl-managed-remote-access-ports/` subdir
keyed identically (fixing D15/D16). `None` home ⇒ read returns empty, persist
returns `Ok(())` (in-memory only), mirroring `settings_store::persist`.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-server managed_ports:: 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
test -f crates/freshell-server/src/managed_ports.rs && echo present
cargo test -p freshell-server managed_ports:: 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/managed_ports.rs crates/freshell-server/src/main.rs crates/freshell-server/Cargo.toml
git commit  # paste falsifier output
```

Commit message: `feat(net): instance-scoped managed-ports persistence (fixes D15/D16)`

## Task 3.3: `POST /api/network/configure-firewall` + confirmed disable lanes — confirmation protocol + 409 lock

**Files:**
- Modify: `crates/freshell-server/src/network.rs` — add `Arc<tokio::sync::Mutex<ConfirmationGate>>` + `managed_ports` to `NetworkState`; add the route + handler + the SHARED action-resolution ladder; REPLACE Task 2.4's disable placeholder (409 pre-check + throwaway-token block) with the full gate-issued disable flow
- Modify: `crates/freshell-server/src/main.rs:900-907` (construct the gate + the managed-ports store — read Task 3.2's constructor signature; use the real home, cwd and port)
- Test: `crates/freshell-server/src/network.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `freshell_platform::elevated::{ConfirmationGate, ConfirmationAction, ElevationDecision, elevation_runner_live, spawn_via, ElevationOutcome}`, `ManagedPortsStore`, `port_forward` planners (Ipv4Addr), `firewall::firewall_commands`.
- Produces: `NetworkState.gate: Arc<tokio::sync::Mutex<ConfirmationGate>>`; `NetworkState.managed_ports: Arc<ManagedPortsStore>` (the File Structure table's promised wiring); route `POST /api/network/configure-firewall`; handler `configure_firewall`; the full confirmed disable protocol (`windows-disable`/`wsl2-disable` lanes, replacing the Task-2.4 placeholder); separate `RepairAction` and `DisableAction` enums (fixes D19 — the unreachable `terminal`-on-disable state is unrepresentable).

**Behavior (matches `network-router.ts:617-758` + the confirmation protocol `:89-262`; `src/lib/firewall-configure.ts:3-14` is the authoritative client union):**

1. Auth → 401; strict-parse (`ConfirmFirewallRequest`) → 400.
2. `gate.is_repair_in_flight()` → **409 `{"error":"Firewall configuration already in progress","method":"in-progress"}`** (the `method` field is load-bearing — the client reads `details.method`). Checked FIRST, before I/O.
3. Resolve the repair action from fresh status+settings (`resolveRepairAction` `:264-320`):
   - not remote-access-enabled → `{method:"none",message:"Remote access is not enabled"}`
   - WSL2 portOpen true → `{method:"none",message:"No configuration changes required"}`; else compute the WSL plan → `ready` ⇒ confirmable `wsl2-repair`; `noop|not-wsl2|disabled` ⇒ `No configuration changes required`; `error` ⇒ 500 `{"error":<message>}`.
   - Windows: no commands ⇒ `{method:"none",message:"No firewall detected"}`; portOpen true ⇒ `No configuration changes required`; else confirmable `windows-repair`.
   - linux/macos with commands ⇒ `{method:"terminal","command": commands.join(" && ")}` — the client opens a terminal tab; the SERVER NEVER RUNS IT (NET-10).
4. Confirmable + no/mismatched token → **200 `confirmation-required`** with a fresh UUID bound to the action; NO OS call (`gate.issue_confirmation(action, &uuid)`).
5. Confirmable + matching token → `gate.try_acquire_repair_lock()` (lose → 409) → RE-RESOLVE the action under the lock (TOCTOU guard `:672-700`); fresh action differs ⇒ release + re-issue a new token; else `gate.consume_confirmation(token, action)` (single-use, constant-time via Slice 0) → dispatch via `spawn_via(&runner, command, script)` where `runner = elevation_runner_live()` in production (Unsupported off Windows) or an injected `Fake` in tests → on `Started` persist managed ports + respond `{method, status:"started"}`; on failure outcomes release the lock, `configuring=false`, NO persisted success (NET-07).
6. Broadcast `settings.updated` only when settings actually changed.
7. **Confirmed disable lanes (REPLACES the Task-2.4 placeholder; matches `network-router.ts:448-615`):** `resolve_disable_action` ports `resolveRemoteAccessDisableAction` (`:322-378`). Plain `{method:"none",message}` outcomes stay exactly as Task 2.4 built them. Confirmable **`windows-disable`** = managed Windows ports non-empty; script = `build_windows_firewall_delete_commands(managed_ports).join("; ")`; response method `"windows-elevated"`. Confirmable **`wsl2-disable`** = teardown plan `ready`; script = the teardown plan's script; response method `"wsl2"`.
   - Confirmable + no/mismatched token → **200 `confirmation-required`** (same body shape as step 4) via `gate.issue_confirmation(action, &uuid)` — gate-stored and action-bound, never Task 2.4's throwaway.
   - Confirmable + matching token → `gate.try_acquire_repair_lock()` (lose → the step-2 409) → RE-RESOLVE the disable action under the lock (TOCTOU, `:507-512`); action changed ⇒ release + re-issue a fresh token with **200** (never 4xx); else `gate.consume_confirmation(token, action)` → dispatch via `spawn_via(&runner, ...)` exactly as step 5 (fake-backed in tests; `elevation_runner_live()` is `Unsupported` off Windows — the live elevated effect stays HOST-BLOCKED, Task 3.6).
   - On `Started`: apply the disabled state (port of `applyRemoteAccessDisabledState` `:119-132` + truthful-bind deviation #6): `rebind.serve_on(127.0.0.1)` + persist `{host:"127.0.0.1","configured":true}` (persist-failure handling identical to Task 2.4's fail-safe) + `bind.set("127.0.0.1")` + `facts.invalidate()` + broadcast; then clear the lane's managed ports via `state.managed_ports` (clear errors logged, not fatal — the TS swallows them too). Respond **200 `{"method":"windows-elevated"|"wsl2","status":"started"}`** (`:588-590`). Failure outcomes release the lock and persist nothing (NET-07), mirroring step 5.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn configure_firewall_first_post_issues_confirmation_without_running_anything() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state_firewall_confirmable(); // seeds windows-active facts + closed port => confirmable
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/configure-firewall")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "confirmation-required");
    assert!(body["confirmationToken"].as_str().unwrap().len() > 0);
}

#[tokio::test]
async fn configure_firewall_409_when_repair_in_flight() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state_firewall_confirmable();
    { state.gate.lock().await.try_acquire_repair_lock(); } // simulate in-flight
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/configure-firewall")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 409);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "in-progress");
    assert_eq!(body["error"], "Firewall configuration already in progress");
}

#[tokio::test]
async fn configure_firewall_requires_auth_and_strict_body() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let state = test_state_firewall_confirmable();
    // no token => 401
    let r = router(state.clone()).oneshot(Request::builder().method("POST").uri("/api/network/configure-firewall")
        .header("content-type","application/json").body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(r.status(), 401);
    // unknown key => 400
    let r = router(state.clone()).oneshot(Request::builder().method("POST").uri("/api/network/configure-firewall")
        .header("x-auth-token","tok").header("content-type","application/json")
        .body(Body::from(r#"{"nope":1}"#)).unwrap()).await.unwrap();
    assert_eq!(r.status(), 400);
    // confirmElevation:false => 400
    let r = router(state).oneshot(Request::builder().method("POST").uri("/api/network/configure-firewall")
        .header("x-auth-token","tok").header("content-type","application/json")
        .body(Body::from(r#"{"confirmElevation":false}"#)).unwrap()).await.unwrap();
    assert_eq!(r.status(), 400);
}

#[tokio::test]
async fn disable_windows_lane_issues_confirmation_with_exact_contract_body() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let (state, _fake) = test_state_disable_confirmable();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "confirmation-required");
    assert_eq!(body["title"], "Administrator approval required");
    assert_eq!(body["body"], "To complete this, you will need to accept the Windows administrator prompt on the next screen.");
    assert_eq!(body["confirmLabel"], "Continue");
    assert!(body["confirmationToken"].as_str().unwrap().len() > 0);
}

#[tokio::test]
async fn disable_confirmed_repost_dispatches_and_applies_disabled_state() {
    // THE protocol proof that the token is GATE-stored: with Task 2.4's
    // throwaway uuid a confirmed re-POST would loop on confirmation-required
    // forever and this test could never observe a dispatch.
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let (state, fake) = test_state_disable_confirmable(); // fake classifies Started
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from("{}")).unwrap()).await.unwrap();
    let token = body_json(resp).await["confirmationToken"].as_str().unwrap().to_string();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from(format!(r#"{{"confirmElevation":true,"confirmationToken":"{token}"}}"#))).unwrap())
        .await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "windows-elevated");
    assert_eq!(body["status"], "started");
    assert_eq!(fake.call_count(), 1, "exactly one elevated dispatch");
    let s = state.settings.get().await;
    assert_eq!(serde_json::to_value(&s.network).unwrap()["host"], "127.0.0.1");
    assert_eq!(state.bind.get().await, "127.0.0.1");
    assert!(state.managed_ports.read_windows().is_empty(), "managed ports cleared");
}

#[tokio::test]
async fn disable_stale_token_reissues_fresh_confirmation_and_never_dispatches() {
    use axum::body::Body; use axum::http::Request; use tower::util::ServiceExt;
    let (state, fake) = test_state_disable_confirmable();
    let bogus = uuid::Uuid::new_v4().to_string();
    let resp = router(state.clone())
        .oneshot(Request::builder().method("POST").uri("/api/network/disable-remote-access")
            .header("x-auth-token","tok").header("content-type","application/json")
            .body(Body::from(format!(r#"{{"confirmElevation":true,"confirmationToken":"{bogus}"}}"#))).unwrap())
        .await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["method"], "confirmation-required");
    assert_ne!(body["confirmationToken"].as_str().unwrap(), bogus);
    assert_eq!(fake.call_count(), 0, "no dispatch on a mismatched token");
    let s = state.settings.get().await;
    assert_eq!(serde_json::to_value(&s.network).unwrap()["host"], "0.0.0.0", "settings untouched");
}
```

Add `fn test_state_firewall_confirmable()` seeding `NetworkFactsCache` with
Windows-active facts + closed port (so the ladder yields a confirmable
`windows-repair`) and constructing the new `gate` + `managed_ports` fields.
Add `fn test_state_disable_confirmable() -> (NetworkState, /* fake handle */)`:
Windows-active facts, bind AND persisted settings at `0.0.0.0`/`configured:true`
(the enabled precondition the resolver checks first), a `managed_ports` store on
a tempdir home with ONE persisted port (so the ladder yields a confirmable
`windows-disable`), and the Task-3.3 runner seam wired to a `FakeCommandRunner`
whose rule classifies the elevated dispatch as `Started`; return the fake so
tests can assert `call_count()`.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server network::tests::configure_firewall 2>&1 | tail -20`
Expected: compile/404 — field + route absent.

- [ ] **Step 3: Add the gate field, wire main.rs, implement the route + ladders**

`NetworkState` gains:
```rust
    /// Confirmation/elevation state machine (one outstanding action-bound token,
    /// in-progress lock). Shared by configure-firewall AND disable-remote-access.
    pub gate: std::sync::Arc<tokio::sync::Mutex<freshell_platform::elevated::ConfirmationGate>>,
    /// Instance-scoped managed-ports persistence (Task 3.2). Consumed by the
    /// confirmed disable lanes and the step-5 Started persist.
    pub managed_ports: std::sync::Arc<crate::managed_ports::ManagedPortsStore>,
```
`main.rs:900-907`: `gate: Arc::new(tokio::sync::Mutex::new(freshell_platform::elevated::ConfirmationGate::new())),`
plus `managed_ports: Arc::new(/* Task 3.2 constructor: real home, cwd, port */)`,
and the `test_state` helpers construct both too.

Register `.route("/api/network/configure-firewall", post(configure_firewall))`.
Implement `configure_firewall` per behavior steps 1-6. Extract resolution into
`async fn resolve_repair_action(state) -> RepairAction` and
`async fn resolve_disable_action(state) -> DisableAction` (SEPARATE enums — fixes
D19). REWRITE `disable_remote_access`'s non-Linux tail per behavior step 7: wire
the 409 pre-check (`gate.is_repair_in_flight()`), DELETE the Slice-2
throwaway-token block, and implement issue → re-resolve-under-lock → consume →
dispatch → apply-disabled-state through the same gate + runner seam as
`configure_firewall`. Use `uuid::Uuid::new_v4().to_string()` for tokens.
Dispatch via a small `fn elevation_runner_for(state) -> ElevationRunner` returning
`elevation_runner_live()` in production and a test-injected `Fake` under
`#[cfg(test)]` (or expose a gate/dispatch helper the tests call directly). Persist
managed ports on `Started` via `ManagedPortsStore`. Broadcast `settings.updated`
only on actual settings change. Hold `state.net_mutation.lock().await` across the
post-dispatch persist/broadcast section (managed ports + settings), matching
Tasks 2.3/2.4 (A-08).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server network::tests 2>&1 | tail -30`
Expected: new `configure_firewall_*` AND `disable_*` protocol tests PASS; all prior tests PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c '"/api/network/configure-firewall"' crates/freshell-server/src/network.rs  # must be >0
grep -c 'pub gate:' crates/freshell-server/src/network.rs                          # must be >0
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs crates/freshell-server/src/main.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): configure-firewall + confirmed disable lanes — confirmation protocol + 409 lock (NET-04/06 wire)`

## Task 3.4: Wire `stale` managed-Windows-ports + WSL2 plan assembly behind fakes (NET-04/05)

**Files:**
- Modify: `crates/freshell-server/src/network.rs` — feed the `stale` input of `build_network_status` from `get_existing_managed_windows_firewall_ports` over a runner; wire the WSL2 `ready` plan from read-only `get_wsl_ip`/`get_existing_port_proxy_rules`/`get_existing_firewall_ports`
- Test: `crates/freshell-server/src/network.rs` tests + `crates/freshell-platform` golden tests

**Interfaces:**
- Consumes: `port_forward::{get_wsl_ip, get_existing_port_proxy_rules, get_existing_firewall_ports, build_wsl_port_forwarding_plan}` (Ipv4Addr), `firewall::{get_existing_managed_windows_firewall_ports, build_windows_firewall_repair_commands, managed_windows_firewall_rule_name}`.
- Produces: `stale` no longer hardcoded `false`; a golden test pins the WSL plan from THIS host's real captured `netsh interface portproxy show all` (proving no add for the already-satisfied 3001 rule); a golden test proving the real `FreshellLANAccess` rule and an unrelated sentinel are NEVER in a delete command.

- [ ] **Step 1: Write the failing golden tests**

In `crates/freshell-platform/src/port_forward.rs` tests:

```rust
#[test]
fn plan_sees_preexisting_3001_rule_as_satisfied_and_emits_no_add_for_it() {
    let capture = "\
Listen on ipv4:             Connect to ipv4:
Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         3412        172.30.149.249  3412";
    let rules = parse_port_proxy_rules(capture);
    let plan = build_wsl_port_forwarding_plan(
        &[3001], &[3001], "172.30.149.249".parse().unwrap(),
        &rules, &[3001], &[3001]);
    assert!(matches!(plan, WslPortForwardingPlan::Noop { .. }),
        "planner must treat the pre-existing 3001 portproxy+firewall as satisfying");
}
```

In `crates/freshell-platform/src/firewall.rs` tests:

```rust
#[test]
fn delete_commands_never_touch_unrelated_or_freshelllanaccess_rules() {
    let cmds = build_windows_firewall_delete_commands(&[3001]);
    let joined = cmds.join(" ; ");
    assert!(!joined.contains("FreshellLANAccess"));
    assert!(!joined.contains("SomeUnrelatedSentinelRule"));
    assert!(joined.contains(&managed_windows_firewall_rule_name(3001)));
}
```

In `network.rs` tests, add a `stale`-wiring test using a `FakeCommandRunner` that
reports a managed port NOT in the required set ⇒ status `firewall.portOpen`
becomes `false` and `remoteAccessNeedsRepair` true (Windows branch).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-platform port_forward::tests::plan_sees 2>&1 | tail -20`
Expected: RED (or, if the planner is already correct, the `network.rs` `stale`
wiring test is the RED one that drives the change).

- [ ] **Step 3: Wire `stale` + WSL plan assembly**

In `build_status_value`/`build_network_status`, replace hardcoded
`let stale = false;` (`network.rs:361`, inside the pure `build_network_status`)
with a computed value:
- Windows + firewall active: `stale = get_existing_managed_windows_firewall_ports(runner)` contains any port not in `remote_access_ports`.
- WSL2 + rawPortOpen true: recompute the WSL plan; `stale` iff `plan` is `Ready`.
Use a `StdCommandRunner` at the call boundary in production (read-only `netsh ... show`), as `resolve_live_network_facts` does; inject a `FakeCommandRunner` in tests. Keep all mutation OUT — read-only queries only.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-server -p freshell-platform 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
grep -c 'get_existing_managed_windows_firewall_ports' crates/freshell-server/src/network.rs  # must be >0
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs crates/freshell-platform/src/port_forward.rs crates/freshell-platform/src/firewall.rs
git commit  # paste falsifier output
```

Commit message: `feat(net): wire stale managed-ports + WSL2 plan assembly behind read-only fakes (NET-04/05)`

## Task 3.5: NET-07 outcome matrix — denial / timeout / partial / verification-failure golden tests

**Files:**
- Modify: `crates/freshell-server/src/network.rs` tests (behavioral) + `crates/freshell-platform/src/elevated.rs` tests (classification)

**Interfaces:**
- Consumes: `ElevationOutcome`, `ConfirmationGate`, `FakeCommandRunner`.
- Produces: four tests proving each failure outcome (a) releases the lock exactly once, (b) leaves `firewall.configuring == false`, (c) persists NO success, (d) a subsequent success after switching the fake to a good response works; plus the token-protocol trio (single-use replay, wrong-action re-issue, parallel-confirm 409) — Rust-only BY VALIDATED NECESSITY (ledger A-06, reports/V5.md: no live lane on this host ever issues a confirmation token under `FRESHELL_DISABLE_WSL_PORT_FORWARD=1`); plus a suite-wide assertion that no `netsh ... add|delete|set` and no `Start-Process -Verb RunAs` reached a real runner (`FakeCommandRunner::call_count`) and the compile-time unreachability test from Task 3.1.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn elevation_denial_releases_lock_and_persists_no_success() {
    // Inject a Fake runner returning "canceled by the user"; drive configure-firewall
    // through the confirm phase => Denied. Assert: gate not in-flight afterward,
    // status.firewall.configuring == false, settings.network unchanged, and a later
    // run with a good Fake succeeds.
}

#[test]
fn no_real_os_mutation_command_reaches_a_runner() {
    // A FakeCommandRunner with no rules records every call; assert its call_count
    // matches the expected read-only-only count and that no recorded arg contains
    // "add rule" / "delete rule" / "portproxy add" / "RunAs". Combined with
    // on_non_windows_the_live_runner_is_unsupported (Task 3.1), this proves zero
    // real OS mutation on this host.
}

#[tokio::test]
async fn confirmation_token_is_single_use() {
    // Issue -> confirm (Started via a good Fake) -> REPLAY the same token: the
    // second POST must yield a NEW confirmation-required (fresh token), never a
    // second dispatch (FakeCommandRunner::call_count unchanged).
}

#[tokio::test]
async fn wrong_action_token_reissues_and_never_executes() {
    // A token issued for one action presented where the freshly-resolved action
    // differs => re-issue (fresh token bound to the new action), zero runner calls.
}

#[tokio::test]
async fn parallel_confirmed_posts_one_wins_one_409() {
    // Two simultaneous confirmed POSTs (tokio::join!): exactly one dispatches;
    // the other gets 409 {"error":"Firewall configuration already in progress",
    // "method":"in-progress"}. Live-unreachable on this host (ledger A-06), so
    // this Rust test is the ONLY 409-lock race proof - do not delete it.
}
```

Model timeout/partial/verification-failure by having `configure_firewall` re-run
the verifier plan after `Started` and downgrade to `VerificationFailed` /
`PartialFailure` when the recomputed plan is still `Ready` (port of `verifySuccess`
`:380-410`). Test each by seeding the post-dispatch fake facts so the verifier
still finds work.

- [ ] **Step 2: Run to verify failure** → **Step 3: implement the verifier downgrade + settle logic** → **Step 4: run to verify pass.**

Run: `cargo test -p freshell-server network::tests 2>&1 | tail -30` — all PASS.

- [ ] **Step 5: Falsifier + commit**

```bash
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5
cargo clippy -p freshell-server -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
git add crates/freshell-server/src/network.rs crates/freshell-platform/src/elevated.rs
git commit  # paste falsifier output
```

Commit message: `test(net): NET-07 elevation outcome matrix (denial/timeout/partial/verification-failure) behind fakes`

## Task 3.6: HOST-BLOCKED evidence record for NET-04/05/07

**Files:**
- Create: `docs/plans/2026-07-28-net-windows-deferred-evidence.md`

- [ ] **Step 1: Write the evidence doc**

Create the file documenting, per requirement:
- NET-04 (Windows firewall configure/repair), NET-05 (WSL2 forwarding), NET-07
  (elevation denial/timeout/partial/verification) are **HOST-BLOCKED**: they
  require a disposable elevated Windows VM this Linux host is not and the safety
  rules forbid simulating live.
- Evidence the CODE is complete and tested — list exact test names + files:
  - `crates/freshell-platform/src/elevated.rs`: `elevated_args_golden_no_quotes`, `on_non_windows_the_live_runner_is_unsupported_and_never_spawns`, `fake_runner_dispatch_classifies_outcomes`, `source_only_constructs_real_under_cfg_windows`.
  - `crates/freshell-platform/src/firewall.rs`: the add/delete/repair goldens + `delete_commands_never_touch_unrelated_or_freshelllanaccess_rules`.
  - `crates/freshell-platform/src/port_forward.rs`: the WSL script goldens + `plan_sees_preexisting_3001_rule_as_satisfied_and_emits_no_add_for_it`.
  - `crates/freshell-server/src/network.rs`: `configure_firewall_*`, `disable_windows_lane_issues_confirmation_with_exact_contract_body`, `disable_confirmed_repost_dispatches_and_applies_disabled_state`, `disable_stale_token_reissues_fresh_confirmation_and_never_dispatches`, `elevation_denial_releases_lock_and_persists_no_success`, `no_real_os_mutation_command_reaches_a_runner`.
- A statement that these boxes stay UNCHECKED in the parity checklist; the live
  effect is unexecuted BY DESIGN.

- [ ] **Step 2: Falsifier + commit**

```bash
test -f docs/plans/2026-07-28-net-windows-deferred-evidence.md && echo present
git add docs/plans/2026-07-28-net-windows-deferred-evidence.md
git commit
```

Commit message: `docs(net): HOST-BLOCKED deferred-with-evidence record for NET-04/05/07`

---

# HARNESS — scripts/verify-remote-access.sh

One self-contained bash script that boots the built server on an ephemeral test
port with an isolated HOME, exercises all five endpoints (auth ±), proves
expose/retract at tiers a+b, runs the NET-08 negative matrix, reaps everything it
started, and does a read-only host-state identity self-proof. Exits 0 only if all
required checks pass. **It must fail loudly if absent** (a prior run reported green
on `No such file or directory`) — the Definition of Done checks
`test -x scripts/verify-remote-access.sh`.

Style templates: `scripts/deploy-tab-diff.sh` (header + exit-code table +
read-only safety note + subcommand dispatch) and `scripts/sandbox-test.sh`
(`set -euo pipefail`, `REPO_ROOT` derivation, usage guard).

## Task 5.1: Harness Phase 0–1 (preflight + boot)

**Files:**
- Create: `scripts/verify-remote-access.sh` (Phases 0–1 + skeleton)

- [ ] **Step 1: Write the skeleton with a self-test**

Create `scripts/verify-remote-access.sh`:

```bash
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
```

`chmod +x scripts/verify-remote-access.sh`.

- [ ] **Step 2: Run the phase 0–1 smoke (must exit 0, must not touch 3001)**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
cargo build --release -p freshell-server 2>&1 | tail -3
scripts/verify-remote-access.sh --verbose ; echo "exit=$?"
ss -ltn | grep ':3001 ' && echo "live 3001 still up (good)"
```
Expected: prints `phase0+1 OK (port=<high> wsl_ip=172.30.x.x)`, `exit=0`; live 3001 untouched.

- [ ] **Step 3: Falsifier + commit**

```bash
test -x scripts/verify-remote-access.sh && echo executable
grep -c 'FRESHELL_DISABLE_WSL_PORT_FORWARD=1' scripts/verify-remote-access.sh  # must be >0
grep -c '3001' scripts/verify-remote-access.sh                                 # must be >0
git add scripts/verify-remote-access.sh
git commit  # paste smoke output
```

Commit message: `feat(net): verify-remote-access harness — Phase 0-1 preflight + boot`

## Task 5.2: Harness Phase 2–4 (endpoint surface auth±, expose, retract) with the vantage ladder

**Files:**
- Modify: `scripts/verify-remote-access.sh`

- [ ] **Step 1: Add Phases 2–4**

Add functions and call them from `main` after `phase1_boot`. Add a curl helper:

```bash
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
```

- **Phase 2 — endpoint surface (auth ±):** for each of the five endpoints, one
  request WITH auth and one WITHOUT. Assert authed → 200 (POSTs need a valid
  body); unauthed → 401 with `{"error":"Unauthorized"}`. On `GET /api/network/status`
  assert EVERY `NetworkStatus` key present with correct JSON type via `jq` —
  `firewall.portOpen` is nullable: presence, not non-null, is the assertion
  (`configured, host, remoteAccessEnabled, remoteAccessRequested,
  remoteAccessNeedsRepair, port, lanIps, machineHostname, firewall{platform,
  active, portOpen, commands, configuring}, rebinding, devMode, accessUrl`), and
  content-type exactly `application/json` — no charset parameter: axum's
  `Json` responder emits none, and the repo's own Slice-1 test pins this
  (`assert_eq!(content_type, "application/json")`,
  `crates/freshell-server/src/network.rs:791`).
- **Phase 3 — expose:** `api POST /api/network/configure '{"host":"0.0.0.0","configured":true}'`
  → 200; status `host=="0.0.0.0"`, `configured==true`, `rebindScheduled==false`;
  `firewall.portOpen==null` and `remoteAccessEnabled==false` — VALIDATED truth at
  non-3001 ports on this host (ledger A-05, reports/V3.md: the wsl2 probe targets
  `lanIps[0]`, the Windows LAN IP, reachable only through the 3001-scoped
  portproxy, so the probe times out ⇒ `null`; wsl2 `remoteAccessEnabled` requires
  `portOpen==true`). Exposure ground truth is the vantage ladder, NOT those two
  fields: tier (a) `curl http://127.0.0.1:$PORT/api/health` → 200;
  **tier (b) `[ "$(tier_b)" = 200 ]` REQUIRED**; tier (c) 200 or documented
  degradation. Budget ~3s per status call on wildcard binds (uncached probe
  measured ~2.0–2.2s live).
- **Phase 4 — retract:** `api POST /api/network/disable-remote-access '{}'` → 200 with
  `method`; status `host=="127.0.0.1"`, `portOpen==null`, `remoteAccessEnabled==false`;
  **tier (b) `[ "$(tier_b)" = REFUSED ]` REQUIRED**; tier (a) still 200;
  `ss -ltn | grep -c ":$PORT "` shows exactly ONE listener, bound `127.0.0.1`.
  The disable response is emitted only after the old listener is provably closed
  (Task 2.1 barrier), so these checks may run immediately; still retry tier (b)
  once after 2s before failing (powershell.exe flakiness, not drain).

Each assertion increments a pass/fail counter; a required failure calls
`fail_required`.

- [ ] **Step 2: Run it**

```bash
scripts/verify-remote-access.sh --verbose ; echo "exit=$?"
```
Expected: Phases 2–4 all PASS; tier (b) 200 when exposed, REFUSED after disable; `exit=0`.

- [ ] **Step 3: Falsifier + commit**

```bash
grep -c 'Invoke-WebRequest' scripts/verify-remote-access.sh   # tier b present
scripts/verify-remote-access.sh >/tmp/vra.out 2>&1; echo "exit=$?"; tail -20 /tmp/vra.out
git add scripts/verify-remote-access.sh
git commit  # paste output
```

Commit message: `feat(net): harness Phase 2-4 — endpoint surface + expose/retract at tiers a+b (NET-01/02/06)`

## Task 5.3: Harness Phase 5 (restart / NET-09 byte-preservation)

**Files:**
- Modify: `scripts/verify-remote-access.sh`

- [ ] **Step 1: Add Phase 5**

- SIGTERM the owned pid (ownership-verified via `/proc/<pid>/cwd` +
  `/proc/<pid>/cmdline`; bounded wait; never a blind SIGKILL; never pid holding 3001).
- Diff `config.json`: `settings.network` reflects the chosen state; **every other
  top-level key byte-identical** — compare each `SHA_<key>` from Phase 0:
  ```bash
  for k in sessionOverrides terminalOverrides serverSecrets completedMigrations recentDirectories projectColors someUnknownFutureKey; do
    now="$(jq -c ".$k" "$HOME_DIR/.freshell/config.json" | sha256sum | cut -d' ' -f1)"
    eval "orig=\$SHA_$k"
    [ "$now" = "$orig" ] || fail_required "top-level key $k changed across mutation"
  done
  ```
- Restart the server on the same isolated HOME **with the same env as Phase 1 —
  in particular `FRESHELL_DISABLE_WSL_PORT_FORWARD=1` and still no
  `FRESHELL_BIND_HOST`** (a bare restart silently changes lanes — reports/V5.md);
  assert status shows the persisted state (`host=="127.0.0.1"`); tier (b) REFUSED.
  This is the live proof of Tasks 0.3 + 2.2b (ledger A-04).

- [ ] **Step 2: Run + Step 3: Falsifier + commit**

```bash
scripts/verify-remote-access.sh >/tmp/vra.out 2>&1; echo "exit=$?"; grep -i 'phase 5' /tmp/vra.out
grep -c 'sha256sum' scripts/verify-remote-access.sh   # per-key preservation present
git add scripts/verify-remote-access.sh
git commit  # paste output
```

Commit message: `feat(net): harness Phase 5 — restart + NET-09 byte-preservation`

## Task 5.4: Harness Phase 6 (NET-08 negative matrix, 15 cases)

**Files:**
- Modify: `scripts/verify-remote-access.sh`

- [ ] **Step 1: Add Phase 6** — each case asserts rejection AND zero side effects
  (config sha unchanged, `ss` listener set unchanged). Cases:

  1. no token → 401
  2. wrong token → 401
  3. `configure {}` / missing `host` / missing `configured` → 400 `Invalid request`
  4. `configure {"host":"1.2.3.4",...}` → 400
  5. `configure {"host":"0.0.0.0; rm -rf /",...}` → 400
  6. `configure` `{"host":"$(id)"}` / backtick / pipe / newline variants → 400
  7. `configure {"host":"0.0.0.0","configured":"yes"}` → 400
  8. `disable-remote-access {"unknownKey":1}` (strict) → 400
  9. `configure-firewall {"confirmElevation":false}` → 400
  10. `configure-firewall {"confirmationToken":""}` → 400
  11. token-shaped request to `configure-firewall` (`{"confirmationToken":"<uuid>"}`)
      → 200 `method:"none"` and ZERO side effects (config sha unchanged, listener
      set unchanged). VALIDATED (ledger A-06, reports/V5.md): with
      `FRESHELL_DISABLE_WSL_PORT_FORWARD=1` on this host, NO live lane ever
      issues a confirmation token, so token replay / wrong-action / parallel-409
      are structurally unreachable live — they are covered by the Rust tests in
      Task 3.5 (`confirmation_token_is_single_use`,
      `wrong_action_token_reissues_and_never_executes`,
      `parallel_confirmed_posts_one_wins_one_409`) instead.
  12. same token-shaped request against `disable-remote-access` → 200
      `method:"none"`, zero side effects.
  13. two parallel `disable-remote-access` POSTs → both 200 `method:"none"`,
      config sha afterwards unchanged and consistent (the net_mutation lock
      serializes them; no live 409 is expected — the 409 race is Rust-tested).
  14. injection strings in `confirmationToken` (`$(id)`, backtick, newline
      variants) → 200 `method:"none"` (non-empty strings pass shape validation
      BY DESIGN — the real property is behavioral): zero side effects, nothing
      reaches a runner, config sha + `ss` listener set unchanged.
  15. positive control — one valid `configure` still succeeds → 200

  Also `grep -F "$AUTH_TOKEN" "$HOME_DIR/server.log"` → MUST be absent (NET-03;
  scan the LOG only — the token legitimately appears in `accessUrl` response
  bodies, reports/V3.md).

  Cases 5/6/14 are ALSO proved structurally by the Rust unit tests (`host` enum,
  `wsl_ip: Ipv4Addr`, `FakeCommandRunner::call_count()==0`); the harness proves
  them live too — both required, neither substitutes for the other. The token
  PROTOCOL cases (replay / wrong-action / parallel 409) are Rust-only by
  validated necessity, not by preference.

- [ ] **Step 2: Run + Step 3: Falsifier + commit**

```bash
scripts/verify-remote-access.sh >/tmp/vra.out 2>&1; echo "exit=$?"; grep -ci 'net-08\|case' /tmp/vra.out
git add scripts/verify-remote-access.sh
git commit  # paste output
```

Commit message: `feat(net): harness Phase 6 — NET-08 negative matrix (live cases + degraded token variants) + token-never-logged`

## Task 5.5: Harness Phase 7 (cleanup, safety self-proof, report.json) + tier-c gating

**Files:**
- Modify: `scripts/verify-remote-access.sh`

- [ ] **Step 1: Add Phase 7 + the `cleanup` trap + tier-c gating**

Replace the placeholder `cleanup()` with an ownership-verified reaper:

```bash
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
```

Phase 7 proper:
- Assert no listener remains on `$PORT` (`ss -ltn | grep -q ":$PORT " && fail_required "listener leaked"`).
- **Safety self-proof:** re-run BOTH read-only captures — `netsh interface portproxy show all`
  and `netsh advfirewall firewall show rule name=FreshellLANAccess` — and diff each
  against its own Phase-0 baseline (`HOST_STATE_BEFORE` and `FIREWALL_STATE_BEFORE`,
  both captured in Task 5.1's `phase0_preflight`). Both MUST be identical →
  `HOST_STATE_UNCHANGED=1`; any difference → `HOST_STATE_UNCHANGED=0` + `fail_required`.
- **Tier-c gating:** unconditional read-only sanity control
  `ssh -o BatchMode=yes -o ConnectTimeout=8 shapiroserver2 "curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://192.168.3.50:3001/api/health"`
  (record; non-200 → `tier_c_vantage: unavailable`, a NOTE not a failure). When not
  `--tier-c` or port ≠ 3001, add a `DEGRADATIONS` entry with the exact reason
  `firewall allow scoped to 3001 only (FreshellLANAccess LocalPort=3001); harness port <N> may not open a new rule (safety rule)`.
  With `--tier-c` + 3001: additionally require (i) nothing listening on 3001,
  (ii) a portproxy rule `0.0.0.0 3001 -> <WSL_IP> 3001`, (iii) connect-address ==
  current `WSL_IP`, else degrade with `portproxy target <old> != current eth0 <new>`.
- Write `report.json`:
  ```bash
  jq -n --arg port "$PORT" --arg wsl "$WSL_IP" \
     --argjson passed "$([ "$REQUIRED_FAIL" = 0 ] && echo true || echo false)" \
     --argjson unchanged "$([ "$HOST_STATE_UNCHANGED" = 1 ] && echo true || echo false)" \
     '{port:($port|tonumber), wsl_ip:$wsl,
       tiers:{a:{},b:{},c:{status:"'"$TIER_C_STATUS"'",reason:"'"$TIER_C_REASON"'"}},
       deferred_host_blocked:["NET-04","NET-05","NET-07"],
       degradations:[], host_state_unchanged:$unchanged, passed:$passed}' \
     > "$REPORT_DIR/report.json"
  cat "$REPORT_DIR/report.json"
  ```
- Exit 0 only if `REQUIRED_FAIL == 0` AND `HOST_STATE_UNCHANGED == 1`. Tier-c
  degradation is NOT a failure; tier-b failure IS.

- [ ] **Step 2: Full run**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
scripts/verify-remote-access.sh --verbose ; echo "exit=$?"
cat /tmp/freshell-verify-remote-access-*/report.json | jq '{passed, host_state_unchanged, tiers}'
ss -ltn | grep ':3001 ' && echo "live 3001 untouched"
```
Expected: `exit=0`, `passed:true`, `host_state_unchanged:true`, tier b pass, tier c
pass-or-degraded-with-reason; live 3001 untouched.

- [ ] **Step 3: Falsifier + commit**

```bash
grep -c 'host_state_unchanged' scripts/verify-remote-access.sh   # must be >0
grep -c 'FreshellLANAccess' scripts/verify-remote-access.sh      # read-only self-proof present
scripts/verify-remote-access.sh >/tmp/vra.out 2>&1; echo "exit=$?"
git add scripts/verify-remote-access.sh
git commit  # paste output + report.json summary
```

Commit message: `feat(net): harness Phase 7 — cleanup, read-only host-state self-proof, report.json, tier-c gating`

---

# Task 6.1: Record DEVIATIONS (proposed)

**Files:**
- Modify: `port/oracle/DEVIATIONS.md` (append; the antagonist adjudicates — leave status `proposed`)

- [ ] **Step 1: Append the deviation entries**

Append entries with status `proposed`, each with objective_defect (a TS
`file:line` citation), port_behavior, and pinning_test (a test name from this
plan). `port/oracle/DEVIATIONS.md` uses the `DEV-NNNN` / `EDEV-NN` ID scheme —
append new `DEV-NNNN` entries continuing the existing sequence (VALIDATED,
reports/V7.md: the file contains no "D1/D15/D16/D19" IDs). Those D-numbers are
plan-internal defect labels, defined ONLY here — do not grep for them:
**D1** = the TS consumes a confirmation token without binding it to the action
that issued it; **D15** = the TS WSL managed-ports file ignores `FRESHELL_HOME`
and is not instance-scoped; **D16** = the TS managed-ports writes are
non-atomic; **D19** = the TS models repair and disable actions as one type,
leaving an unreachable `terminal`-on-disable state representable.

1. **Transactional rebind (bind-new-before-persist, `SO_REUSEPORT`)** — defect:
   `server/network-manager.ts:477-483` (`CATASTROPHIC: ... server has no active
   listener`) + persistence-before-proof at `:417` vs NET-02. port_behavior: prove
   new listener first, then persist, then drain; rollback is an infallible socket
   drop. Escape hatch `FRESHELL_REBIND_NO_REUSEPORT=1`. pinning_test:
   `net_bind::tests::serve_on_proves_bind_before_swapping_and_serves_traffic` +
   `foreign_squatter_blocks_our_bind` + harness Phase 3/4.
2. **Settled-status response to `configure`** — answer settled truth +
   `rebindScheduled:false` instead of a desired-state preview; contract-legal per
   `src/store/networkSlice.ts:123-130`. pinning_test:
   `configure_to_all_interfaces_persists_and_reports_settled_host`.
3. **No mass 4009 on rebind** — overlapping listeners let old WS connections drain
   (intentional UX improvement).
4. **NET-08-A/B/C hardening** (`Ipv4Addr` typing + constant-time compare, Slice 0).
5. **Action-bound token consumption everywhere** (fixes D1); **instance-scoped,
   `FRESHELL_HOME`-honouring, atomic WSL managed-ports file** (fixes D15/D16);
   **separate disable/repair action enums** (fixes D19).
6. **WSL2 listener rebind is real** — the TS forces `hostChanged=false` on wsl2
   (`network-manager.ts:412-413`) and keeps the listener on 0.0.0.0, using Windows
   portproxy for exposure. Our port binds truthfully on every platform: disable
   really rebinds to loopback (NET-06, provable at tier b) and configure really
   re-exposes. objective_defect: with truthful loopback binding after a disable,
   the TS rule would strand the server loopback-bound with no live re-expose path.
   pinning_test: harness Phase 3/4 tier-b transitions +
   `disable_from_exposed_linux_rebinds_to_loopback_and_persists`.
7. **Kept-as-contract (NOT a bug to fix):** wsl2
   `remoteAccessEnabled = rawPortOpen === true` (`network-manager.ts:349-350`) —
   depended on by `src/lib/share-utils.ts:17-34`; Slice 1 ports it faithfully.
   Note as reviewed and deliberately kept.
8. **Persisted `configured` host outranks the WSL wildcard default** (Task 0.3) —
   objective_defect: `server/get-network-host.ts:42` returns `0.0.0.0` for WSL
   before consulting the persisted config, so a disable that persisted loopback
   is silently re-exposed on the next boot (contradicts NET-02/NET-06 restart
   truthfulness; validated live in reports/V2.md). port_behavior: precedence is
   `FRESHELL_BIND_HOST` → persisted config when `configured:true` → WSL default
   `0.0.0.0` → `HOST` → `127.0.0.1`; unconfigured WSL keeps the wildcard
   default. pinning_test: `wsl_with_configured_host_outranks_wsl_default` +
   `wsl_unconfigured_keeps_wildcard_default` + harness Phase 5.
9. **Fail-safe persist-failure handling on the mutation endpoints** —
   objective_defect: `server/network-manager.ts:501-503` swallows a failed
   revert-persist after a rebind rollback (listener and config silently diverge;
   the client is never told), and the TS disable path has no revert at all.
   port_behavior: `configure` rolls the LISTENER back when the persist fails
   after a successful swap (reality re-matches the unchanged config; if the
   rollback bind itself fails, `bind` stays truthful and a CATASTROPHIC error is
   logged); `disable-remote-access` NEVER re-exposes on an error path — it keeps
   the loopback listener, sets `bind` truthfully, and surfaces the error.
   pinning_test: `configure_rolls_back_the_listener_when_persist_fails` +
   `disable_keeps_loopback_and_reports_error_when_persist_fails`.

- [ ] **Step 2: Commit**

```bash
git add port/oracle/DEVIATIONS.md
git commit
```

Commit message: `docs(net): file remote-access networking deviations (proposed)`

---

# Definition of Done (final falsifier — run before declaring the plan complete)

- [ ] **Run the global falsifier**

```bash
cd /home/dan/code/freshell/.worktrees/remote-access-networking
git log --oneline feat/remote-access-networking | head -25
git status --porcelain server/ shared/ src/            # MUST be empty
# Slice 0
grep -c 'c\.token == t' crates/freshell-platform/src/elevated.rs                              # 0
grep -c 'timing_safe_compare' crates/freshell-platform/src/elevated.rs                        # >0
grep -c 'fn build_port_forwarding_script(wsl_ip: &str' crates/freshell-platform/src/port_forward.rs  # 0
grep -c 'wsl_with_configured_host_outranks_wsl_default' crates/freshell-platform/src/network.rs      # >0
# Slice 2
grep -c '"/api/network/configure"' crates/freshell-server/src/network.rs                      # >0
grep -c '"/api/network/disable-remote-access"' crates/freshell-server/src/network.rs          # >0
grep -c 'socket2' crates/freshell-server/Cargo.toml                                           # >0
grep -c 'net_mutation' crates/freshell-server/src/network.rs                                  # >0
grep -c 'notify_one' crates/freshell-server/src/net_bind.rs                                   # >0
# Slice 3
grep -c '"/api/network/configure-firewall"' crates/freshell-server/src/network.rs             # >0
grep -c 'ElevationRunner::Unsupported' crates/freshell-platform/src/elevated.rs               # >0
# Harness + docs
test -x scripts/verify-remote-access.sh && echo harness-ok
test -f docs/plans/2026-07-28-net-windows-deferred-evidence.md && echo evidence-ok
# Tests + lint
cargo test -p freshell-server -p freshell-platform 2>&1 | tail -5     # all green, >= baseline
cargo clippy -p freshell-server -p freshell-platform --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --check
# Live end-to-end
scripts/verify-remote-access.sh --verbose ; echo "exit=$?"            # exit 0
cat /tmp/freshell-verify-remote-access-*/report.json | jq '{passed, host_state_unchanged}'
```

All greps produce the stated verdicts; `cargo test` is green at ≥ the Slice-1
baseline; the harness exits 0 with `passed:true` and `host_state_unchanged:true`;
NET-04/05/07 are recorded HOST-BLOCKED and left unchecked in the parity checklist.

---

## Self-Review

### 1. Spec coverage (each requirement → covering task)

| Requirement | Covering task(s) | Observable production outcome (no stub) |
|---|---|---|
| NET-01 complete live status | Slice 1 (landed) + Task 3.4 (`stale` unhardcoded) | `GET /api/network/status` returns full `NetworkStatus`; harness Phase 2 asserts every key |
| NET-02 transactional rebind | 0.3, 2.1, 2.2b, 2.3 | `configure` binds+proves the new listener before persist (and `serve_on` returns only after the old socket is provably closed); boot honors persisted host across restart (platform precedence fixed in 0.3); harness Phase 3 tier-b 200; squatter + 100-swap unit tests prove rollback and drain; persist-failure listener rollback pinned by `configure_rolls_back_the_listener_when_persist_fails` |
| NET-03 share URL, token never logged | Slice 1 (`accessUrl`) + harness Phase 6 token-scan | harness greps `server.log` for the token → absent |
| NET-04 Windows firewall configure/repair | 3.1, 3.3, 3.4, 3.5 | golden strings + fake-backed behavior + compile-time unreachability; **HOST-BLOCKED live effect, evidenced 3.6** |
| NET-05 WSL2 forwarding | 3.4 | golden plan from real captured portproxy; **HOST-BLOCKED live effect, evidenced 3.6** |
| NET-06 safe disable | 2.4, 3.3 | `disable-remote-access` live retract on Linux (+ fail-safe persist-failure path); gate-issued confirmed windows/wsl2 disable lanes fake-backed in 3.3; harness Phase 4 tier-b REFUSED, tier-a still 200 |
| NET-07 elevation faults | 3.1, 3.5 | four outcome tests: lock released, `configuring=false`, no false persist; **HOST-BLOCKED live effect, evidenced 3.6** |
| NET-08 secure every mutation | 2.3, 2.4, 3.3, 3.5 + harness Phase 6 | live negative matrix (auth/schema/host-enum/injection/degraded-token cases, each zero-side-effect-checked) + structural Rust tests (enum host, Ipv4Addr, call_count 0, token replay/wrong-action/parallel-409 — live-unreachable on this host, ledger A-06) |
| NET-09 lossless writes | 2.3, 2.4, 2.5 | mutations go through `settings.patch`; black-box + harness Phase 5 per-key sha preservation |
| NET-10 native Linux guidance | Slice 1 + 3.3 `terminal` branch | `configure-firewall` returns `{method:"terminal",command}`; server never runs it |

### 1b. No silent deferrals

Every NET requirement has a covering task producing a real, tested outcome. The
only deferred items — NET-04/05/07 *live elevated side effects* — are HOST-BLOCKED
(hardware this Linux host lacks; safety rules forbid simulation). Their production
code paths are fully implemented and exercised via `FakeCommandRunner` golden
strings, fake-backed behavioral tests, AND a compile-time unreachability proof;
the deferral is recorded with named test evidence in Task 3.6 and left UNCHECKED
in the parity checklist. No stub, mock, or synthetic value stands in for a
required *behavior* — only the live OS mutation is unexecuted, by design. This is
explicitly the spec's own "deferred-with-evidence" disposition, not a scope
reduction. No UNRESOLVED COVERAGE GAP remains.

### 2. Placeholder scan

No "TBD/TODO/handle appropriately". Every code step shows code; every test step
shows the test; every command shows its expected verdict. Where an exact internal
signature could drift (`timing_safe_compare` arg type, the `ServerSettings`
import path, the status-building block refactored into `build_status_value`), the
step names the file:line to read first and the exact contract to preserve —
concrete instruction, not a placeholder.

### 3. Type consistency

- `RebindController` methods (`new`, `set_app`, `has_app`, `serve_on`,
  `shutdown_all`) are named identically across Tasks 2.1–2.4.
- `NetworkState` new fields (`broadcast_tx`, `rebind`, `net_mutation`, `gate`,
  `managed_ports`) are introduced in 2.2 / 3.3 and every later `test_state`
  update and handler references the same names. `net_mutation` (the A-08 serialization lock) is
  acquired in 2.3 / 2.4 / 3.3 with the same held-through-persist contract;
  `LiveListener` is internal to `net_bind.rs`.
- `ConfirmFirewallRequest` (strict) is defined in 2.4 and reused in 3.3.
- `invalid_request` / `build_status_value` are introduced in 2.3 and reused by
  2.4 / 3.3 / 3.4.
- `ElevationRunner` / `ElevationOutcome` / `spawn_via` / `elevation_runner_live`
  are defined in 3.1 and consumed in 3.3 / 3.5.
- `ManagedPortsStore::{windows, read_windows, persist_windows, clear_windows}`
  defined in 3.2, consumed in 3.3.
- Wire shapes (`{"error":"Invalid request","details":[...]}`,
  `{"error":"Unauthorized"}`, `rebindScheduled:false`, the `method` discriminant,
  the 409 `{"error":...,"method":"in-progress"}`, the two `method:"none"` message
  strings) are copied verbatim from the frozen TS contract and are consistent
  across every task that emits them.

No mismatches found.
