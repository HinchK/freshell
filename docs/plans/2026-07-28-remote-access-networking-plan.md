# Remote-access networking on the Rust Freshell server — implementation plan

**Date:** 2026-07-28 (**REVISED 2026-08-02** — re-entry after the first pipeline run
delivered zero code; see §0.0)
**Worktree:** `/home/dan/code/freshell/.worktrees/remote-access-networking`
**Branch:** `feat/remote-access-networking` (PR target `main`). The main checkout
`/home/dan/code/freshell` is shared with other agents and **must not be touched**.
**Goal:** make remote-access networking *work* on the Rust server — all five
client-called endpoints exist and behave, status is truthful, expose/retract is proven
from real external vantages, every mutation is secured (NET-08), and Windows-elevated
behavior is implemented behind injected runners with golden tests but **never executed**.

Scope map: NET-01…NET-10
(`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:502-532`), reconciliation
classes (`docs/plans/2026-07-18-checklist-reconciliation.md:253-266`). The checklist is the
map, not the goal: prioritize working behavior over checkbox parity.

---

## 0.0 Re-entry preamble — what the first run taught us

The 2026-07-28 pipeline reported `success` at every implementation stage and produced
**no code**. `docs/plans/2026-07-28-remote-access-networking-report.md` documents this
honestly: `slice_status`, `slice_mutate`, and `slice_firewall` each left
`crates/freshell-server/src/network.rs` byte-identical to baseline; `run_harness`'s own
output was `bash: scripts/verify-remote-access.sh: No such file or directory`, reported
as success; the converge judge scored **2/7** and recorded "Networking does not work."

Three consequences bind this revision:

1. **Every slice must land as a commit whose diff is inspectable.** A slice is not done
   because an agent says so. The definition of done for each slice below therefore names
   the exact `git`/`grep`/`cargo` command that falsifies a false success claim (§0.5).
   Non-negotiable: *the artifact, not the assertion, is the evidence.*
2. **The harness is the arbiter, and it must exist before it can pass.** `run_harness`
   reporting success against a missing file is the exact failure mode to design out:
   the harness's Phase 0 aborts non-zero if its own required inputs are absent, and the
   converge criteria include "the harness file exists and is executable" as a distinct,
   separately-checkable criterion.
3. **Live-host facts drift and must be re-measured, never inherited.** The prior plan's
   tier-c design was correct on 2026-07-28 and is **wrong today** — see §0.3. Any plan
   that hardcodes last week's port assignment will fail on contact.

The prior run's genuinely useful outputs are retained and built upon:
`docs/plans/2026-07-28-net08-security-audit.md` (a real audit of the unchanged
primitives, findings NET08-A/B/C — folded into Slice 0 below) and the vantage-ladder
concept (re-measured and revised in §0.3).

### 0.0.1 What is real on disk today (verified 2026-08-02, this session)

| Claim | Verification | Result |
|---|---|---|
| Only `GET /api/network/status` is registered | `main.rs:1202` merges `network::router`; `network.rs:84-88` routes exactly one path | Confirmed |
| The other four routes are absent | `grep` for their route literals across `crates/` | 0 hits |
| `scripts/verify-remote-access.sh` absent | `ls scripts/` | Confirmed absent |
| `raw_port_open` hardcoded `None`, `stale` hardcoded `false` | `network.rs:123`, `network.rs:160` | Confirmed |
| Mutating primitives have no caller | `elevated.rs`, `port_forward.rs`, `firewall.rs` builders unreferenced from `freshell-server` | Confirmed |

---

## 0. Preconditions, invariants, and what was verified live

### 0.1 Hard safety invariants (every slice, no exceptions)

Per `port/HANDOFF.md:192-193` (safety rule 6: *"never execute mutating Windows
network/firewall commands (`netsh add/delete`, elevated UAC) — STATUS reads only;
mutation exists solely as…"*):

1. **Never execute mutating Windows network/firewall commands** — no `netsh … add/delete`,
   no `netsh interface portproxy add/delete`, no elevated UAC (`Start-Process -Verb RunAs`).
   Mutation exists **only** as golden-string builders dispatched through an injected
   `CommandRunner`, which in every test is a `FakeCommandRunner`.
2. **Never execute privileged Linux commands** (`ufw`/`iptables`/`sudo`). NET-10 requires
   *guidance text*, not execution. `firewall_commands()` output stays data.
3. **Rebinding the server's own listener** (`127.0.0.1` ↔ `0.0.0.0`) is allowed and is the
   Linux live path — it is our own socket, not OS-global state.
4. **Read-only cross-boundary probes are allowed and expected**: `powershell.exe
   Invoke-WebRequest`, `netsh interface portproxy show all`, `netsh advfirewall firewall
   show rule`, `ipconfig.exe`, `ssh shapiroserver2 curl`. Never create/modify a portproxy
   or firewall rule.
5. `server/`, `shared/`, `src/` are the **frozen reference**. `git diff` on them must stay
   empty. The client is the CONTRACT to satisfy, not code to edit.
6. Isolated `HOME` for every test server; reap every process started, ownership-verified
   (`/proc/<pid>/cwd` + cmdline) — never a broad pattern kill (`AGENTS.md` Process Safety).
7. **Never restart or kill the live self-hosted server** without the user's explicit
   "APPROVED". **As of 2026-08-02 the live server is pid 64553 on port 3001**, cwd
   `/home/dan/code/freshell`, pid file `~/.freshell/rust-server-3001.pid`. This is a
   change from the AGENTS.md note (which says 3002); AGENTS.md is stale on this point and
   §0.3 explains the consequences. **The harness must refuse to bind 3001 and must refuse
   to kill any pid it did not itself start.**
8. All work happens in the dedicated worktree on `feat/remote-access-networking`. Every
   slice is committed durably before the next begins.

### 0.2 Vantage ladder — RE-MEASURED live 2026-08-02 (this session)

| Tier | Vantage | Verified result (2026-08-02) |
|---|---|---|
| (a) | WSL loopback `curl http://127.0.0.1:$PORT/` | 200 against a 0.0.0.0-bound listener on an arbitrary port (3412) |
| (b) | Windows host: `powershell.exe Invoke-WebRequest http://<eth0 IP>:$PORT/` | **`STATUS 200`** against a 0.0.0.0-bound listener on arbitrary port 3412, with `WSL_IP=172.30.149.249` |
| (c) | True LAN: `ssh shapiroserver2 curl http://192.168.3.50:$PORT/` | **200 on port 3001 only**; **`000` (refused) on port 3412** — see §0.3 |

**The decisive property that justifies tier (b)** (established 2026-07-28, unchanged):
WSL's `localhostForwarding` makes `powershell.exe … http://localhost:$PORT/` return 200
even against a **loopback-bound** listener — i.e. `localhost` from Windows *lies*.
Targeting the **eth0 IP** does not: it traverses the real WSL2 NAT boundary, so a 200
truthfully means "0.0.0.0-bound" and a refusal truthfully means "loopback-bound". Tier (b)
is therefore the **bind-address truth test**, it works on **any** port, and it is
**REQUIRED** (never degradable).

### 0.3 Tier (c) has materially changed since the prior plan — READ THIS

The prior plan asserted tier (c) is "valid ONLY on port 3001" and that no server holds
3001. **Both halves are now differently true**, measured this session:

```
ss -ltnp            -> 0.0.0.0:3001  freshell-server pid 64553  (cwd /home/dan/code/freshell)
curl :3001/api/health -> 200          (the LIVE self-hosted production server)
curl :3002/api/health -> 000          (nothing there anymore)
```

I then measured tier (c) against a throwaway `python3 -m http.server` on port **3412**
(chosen because a portproxy rule for 3412 already exists — see the capture below):

```
tier a  ->  200      (loopback works)
tier b  ->  STATUS 200  (0.0.0.0 bind confirmed from the Windows host)
tier c  ->  000      (REFUSED from the true-LAN vantage)
```

Read-only `netsh interface portproxy show all` shows 14 rules including
`0.0.0.0:3412 -> 172.30.149.249:3412`, and the connect-address **matches** the current
eth0 IP. So the portproxy is not the blocker. Read-only `netsh advfirewall firewall show
rule name=FreshellLANAccess` shows the inbound allow rule exists but is scoped
**`LocalPort: 3001`** only. That is the whole explanation:

> **Tier (c) requires BOTH a portproxy rule AND a matching inbound firewall allow. The
> firewall allow exists for 3001 and no other port. Creating another one is forbidden by
> safety rule 6. Therefore tier (c) is structurally available on port 3001 alone — and
> port 3001 is now occupied by the live production server, which we may not restart.**

**Resolution (this plan's decision).** Tier (c) becomes **conditionally available and
degradation-first by default**:

- The harness's default port is an **ephemeral high port**, not 3001. On the default port
  tiers (a) and (b) run and tier (c) **degrades with the documented reason**
  `firewall allow scoped to 3001 only; harness port <N> not permitted to open a new rule`.
  This is a *documented degradation*, exactly as the goal permits — not a silent skip.
- Tier (c) runs **only** under an explicit, guarded opt-in: `--tier-c` **plus** port 3001
  **plus** the live server genuinely not holding 3001. Since the live server *does* hold
  3001 today, the practical effect is that tier (c) requires the user to have separately
  stopped it (their call, their "APPROVED"). The harness never stops it and hard-errors
  if `--port 3001` is requested while pid 64553 (or any pid it did not start) is listening.
- **A read-only tier-(c) sanity control runs unconditionally**: `ssh shapiroserver2 curl
  http://192.168.3.50:3001/api/health` → expect 200 (measured 200 this session). This
  proves the LAN path and the ssh vantage are *alive* without binding anything, so a
  tier-(c) degradation is provably "not permitted here", not "the vantage is broken".
  It is a GET against an existing health endpoint — no mutation, no restart.

This is a strictly more honest arrangement than the prior plan, which would simply have
failed at Phase 0 today.

**Every one of these facts is re-measured at harness start, never inherited from a file.**
`WSL_IP` is re-resolved via `ip -4 addr show eth0`; the portproxy table and the
`FreshellLANAccess` scope are re-read (read-only); the 3001 occupancy is re-checked.
`.verify-vantages.env` from the prior run is treated as a historical note only.

### 0.4 Four defects in the current Rust code (all fixed in Slice 1)

Discovered by reading `crates/freshell-server/src/main.rs:900-906` and `network.rs`:

1. **`NetworkState.settings` is a frozen boot snapshot.** `main.rs:199` does
   `let settings = Arc::new(settings_store.get().await)` and `main.rs:902` hands that
   `Arc<ServerSettings>` to `NetworkState`. After any settings mutation (including our own
   `POST /api/network/configure`), `GET /api/network/status` would keep reporting the
   **boot-time** `network.{configured,host}`. The reference reads the store on every call
   (`network-manager.ts:283`: `await this.configStore.getSettings()`). → must take
   `SettingsStore` (which `settings_store.rs:41` already exposes as a cheap-clone live handle).
2. **`effective_host` is frozen at boot** (`main.rs:903`: `Arc::new(bind_host.clone())`).
   The reference derives it from the **live** `server.address()` every call
   (`network-manager.ts:290-301`). After a rebind, a frozen value is a lie. → must be live
   shared state written by the rebind path.
3. **`facts: OnceCell` caches LAN IPs + firewall for the process lifetime**
   (`main.rs:905`). The reference invalidates both on `configure`
   (`network-manager.ts:419-420`: `this.firewallInfo = null; await this.refreshLanIpsAsync()`)
   and exposes `resetFirewallCache()` (`:536-538`). A `OnceCell` cannot be invalidated. →
   must become a refreshable cache (`RwLock<Option<LiveNetworkFacts>>` + `invalidate()`).
4. **Native-Linux LAN detection returns `Vec::new()`** (`network.rs:243-249`, whose own
   comment admits "other non-WSL hosts … remains unwired (empty) — documented"). This is
   the NET-10 gap, and it *also* silently disables the reachability probe there (the
   reference gates the probe on `lanIps.length > 0`).

These are port defects (the Rust side is wrong relative to the reference), **not**
deviations — no DEVIATIONS.md entry needed. They are why "unhardcode `remoteAccessEnabled`"
is not a one-line change.

### 0.5 Anti-fabrication contract (applies to every slice)

Each slice's "Definition of done" below ends with a **falsifier**: a command whose output
an independent party can check. A slice may not be reported complete unless its falsifier
has been run and its output pasted into the slice's commit message. Additionally:

```bash
# The global falsifier — run before claiming ANY slice complete.
git -C .worktrees/remote-access-networking log --oneline feat/remote-access-networking
git -C .worktrees/remote-access-networking diff --stat HEAD~1   # must be non-empty for a code slice
git -C .worktrees/remote-access-networking status --porcelain server/ shared/ src/  # must be EMPTY
cargo test -p freshell-server -p freshell-platform
```

---

## Slice 0 (prerequisite, folded into Slice 1's commit) — fix NET08-A/B/C before wiring

The prior run's audit (`docs/plans/2026-07-28-net08-security-audit.md:495-497`) found
three real issues in the primitives that are **unreachable today only because nothing
calls them**. This plan wires callers. The audit's own recommendation
(`:520-524`) is to fix them *first*; that advice is adopted verbatim and is a hard
prerequisite for Slice 3.

| Finding | Location | Fix |
|---|---|---|
| **NET08-A** (MEDIUM → HIGH once wired) | `port_forward.rs:338` (`build_port_forwarding_script`) | `wsl_ip: &str` → `std::net::Ipv4Addr`. Injection becomes *structurally impossible*, not filtered. Callers parse at the boundary and reject unparseable input before any script exists. |
| **NET08-B** (LOW, sub-case of A) | same | Same type change eliminates newline smuggling — an `Ipv4Addr` cannot contain `\n`. |
| **NET08-C** (LOW) | `elevated.rs:170`, `:194` | Confirmation-token compare `==` → constant-time (`freshell_platform::network::timing_safe_compare`, already present at `network.rs:212` and already the auth-token path's primitive). |

**Acceptance:** the audit's own PoC (a `;`-injected and a `\n`-injected `wsl_ip`) no
longer compiles as a `&str` argument; a golden test pins the unchanged output for a valid
`Ipv4Addr`; token-compare tests still pass and a new test asserts the constant-time helper
is the one being called.

---

## Slice 1 — Status truthfulness + `GET /api/lan-info`

**Theme:** make `GET /api/network/status` tell the truth on both bind paths, and add the
missing read endpoint. **No mutation anywhere in this slice.**

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | Live probe wiring; `NetworkState` reshape (live settings/host/facts); add `GET /api/lan-info`; keep `build_network_status` pure |
| `crates/freshell-platform/src/network.rs` | Add `detect_lan_ips_from_linux_interfaces()` (NET-10 gap at `network.rs:243-249`); reuse existing `rank_lan_ip_candidates` (`:383`) + `prefix_len_to_netmask` (`:392`) |
| `crates/freshell-platform/src/port_forward.rs`, `elevated.rs` | Slice 0 fixes (NET08-A/B/C) |
| `crates/freshell-server/src/main.rs` | Pass `SettingsStore` + live bind-host handle + refreshable facts into `NetworkState` (`:900-906`) |

### TS reference anchors

- `server/network-router.ts:412-419` — `GET /lan-info` (`{ ips }`; 500 `{error:'Failed to get LAN info'}`).
- `server/network-router.ts:421-429` — `GET /network/status` (raw status; 500 on error).
- `server/network-manager.ts:282-398` — `getStatus()`; specifically:
  - `:291-302` effective-host derivation from the **live** `server.address()`, with the
    `!configured && HOST env` fallback when not yet listening;
  - `:304-323` the reachability probe: **only when `effectiveHost === '0.0.0.0'` and
    `lanIps.length > 0`**, `isPortReachable(port, { host: lanIps[0], timeout: 2000 })` per
    remote-access port; any `false` → `false`, else any `null` → `null`, else `true`;
  - `:325` `remoteAccessRequested = isRemoteAccessEnabled(...)`;
  - `:343` `portOpen = staleManagedWindowsExposure ? false : rawPortOpen`;
  - `:349-351` `remoteAccessEnabled` (wsl2: `rawPortOpen === true`; else `requested && rawPortOpen === true`);
  - `:352-361` `remoteAccessNeedsRepair`; `:362-368` `shareRouteEnabled`;
  - `:370-375` `accessUrl`; `:377-397` the returned `NetworkStatus` shape (`:189-209`).
- `server/network-access.ts:6-19` — `isRemoteAccessEnabled` (already ported at
  `freshell-platform/src/network.rs:94`).
- `server/bootstrap.ts:94-107` `collectLanIpCandidates`, `:151-153` `detectLanIpsFromInterfaces`,
  `:182-193` `detectLanIps` — the native path the Rust side stubs to `Vec::new()`.

### Design

**Probe (the core of NET-01).** One implementation covers both paths because both are a
plain TCP connect:

```rust
async fn probe_port_reachable(host: &str, port: u16, timeout: Duration) -> Option<bool>
```

`tokio::net::TcpStream::connect((host, port))` under `tokio::time::timeout(2s)`:
`Ok(_)` → `Some(true)`; connect refused/unreachable → `Some(false)`; timeout or
resolution/other error → `None` (the reference's `catch → null`, `network-manager.ts:310-312`).

Gate it exactly as the reference does: **run the probe only when `effective_host == "0.0.0.0"`
and `lan_ips` is non-empty.** On a loopback bind, `raw_port_open` stays `None` — that is not
a deferral, it is the reference's own value (`network-manager.ts:304`), so the loopback path
is loopback-faithful *by construction*. This deletes the `raw_port_open: None` deferral
comment at `network.rs:122-123` and the module-doc paragraph at `network.rs:26-34`.

What `lan_ips[0]` means per platform, because it makes the probe meaningful on both:
- **WSL2:** `lan_ips[0]` is the *Windows host's* physical LAN IP (`ipconfig.exe`,
  `bootstrap.ts:113-124`), e.g. `192.168.3.50`. Probing it from inside WSL traverses the
  Windows portproxy + firewall — so `portOpen === true` genuinely means "the whole WSL2
  exposure chain works". This is a **non-loopback vantage reached from inside the process**,
  satisfying the goal's "plain TCP connect to the bound port from a non-loopback vantage
  where possible".
- **Native Linux:** `lan_ips[0]` is this host's own LAN IP → a non-loopback self-connect,
  which is precisely the bind-address truth test. (Requires the NET-10 fix below; without
  it `lan_ips` is empty and the probe never runs — defect #4.)

**Native-Linux LAN detection (NET-10).** In `freshell-platform`:
`detect_lan_ips_from_linux_interfaces(runner)` runs read-only `ip -o -4 addr show`, parses
`<ifname> inet <addr>/<prefix>`, drops `lo`/loopback and `scope host`, converts
prefix→netmask with the existing `prefix_len_to_netmask` (`:392`), and ranks with the
existing `rank_lan_ip_candidates` (`:383`) — i.e. byte-identical ranking to
`bootstrap.ts:94-107 + :151-153`. Wire it into `network.rs:243-249`'s `else` arm (the
branch whose comment currently concedes it is unwired). Golden test uses this host's real
captured `ip -o -4 addr show` output (includes `docker0 172.17.0.1`, which `score_lan_ip`
must rank low, plus the `br-*` bridges) and asserts the ranked order.

**Unhardcode `remoteAccessEnabled` / `needsRepair`.** These are already *derived* correctly
in the pure `build_network_status` (`network.rs:171-183`); they read `false` only because
`raw_port_open` is always `None` (`:123`) and `stale` is a hardcoded literal (`:160`).
Feeding the real probe result fixes both. `stale` (Windows managed-port staleness) stays
`false` on this host and is explicitly **HOST-BLOCKED** (§Slice 3) — but it becomes a
*parameter* now, not a literal, so Slice 3's Windows machinery can drive it under test.

**Live state reshape.**

```rust
pub struct NetworkState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,        // live handle, was Arc<ServerSettings>   (defect 1)
    pub bind: Arc<BindState>,           // live effective host                    (defect 2)
    pub port: u16,
    pub facts: Arc<NetworkFactsCache>,  // refreshable, was OnceCell              (defect 3)
}
```

`BindState` in Slice 1 is read-only (`RwLock<String>` seeded from `resolve_bind_host()`);
Slice 2 gives it the writer. `NetworkFactsCache` = `RwLock<Option<LiveNetworkFacts>>` +
`get_or_refresh()` + `invalidate()`; the read-only subprocesses still run under
`spawn_blocking`.

**`GET /api/lan-info`.** Mounted in the same `network::router()` behind the same
`is_authed` gate (`boot.rs:686`) / `unauthorized()` (`boot.rs:713`), returning
`{"ips": [...]}` from the same cached facts. The audit recommends a shared auth layer over
four hand-copied checks; adopt that here (`axum::middleware::from_fn` scoped to the network
router) so Slices 2–3 cannot forget the gate. On detection failure the reference returns
500 `{"error":"Failed to get LAN info"}` (`network-router.ts:415-418`); our detection is
infallible-with-empty-vec, so 500 is unreachable — **note it, do not fabricate a failure path.**

### Acceptance criteria

1. `GET /api/lan-info` → 200 `{"ips":[...]}` with `application/json; charset=utf-8`;
   401 `{"error":"Unauthorized"}` with no/bad token; contents equal the `lanIps` in
   `GET /api/network/status` from the same process.
2. Bound `0.0.0.0` on a host with a LAN IP: `firewall.portOpen === true`,
   `remoteAccessEnabled === true` (non-wsl2 also requires `remoteAccessRequested`),
   `remoteAccessNeedsRepair === false`, `accessUrl` host is `lanIps[0]`.
3. Bound `127.0.0.1`: `firewall.portOpen === null` (reference-faithful, **not** an invented
   `false`), `remoteAccessEnabled === false`, `accessUrl` host is `localhost`.
4. **Negative-truth test (the one that matters):** 0.0.0.0 bind but the port deliberately
   unreachable from `lanIps[0]` (fixture-injected probe result `Some(false)`) →
   `portOpen === false` and `remoteAccessNeedsRepair === true` on wsl2/windows.
5. Native Linux (`ip -o -4 addr show` golden): `lanIps` non-empty, correctly ranked,
   `172.17.0.1` ranked low, loopback absent.
6. Status reflects a settings change made after boot (proves defect 1), a bind change
   (defect 2), and re-detects LAN/firewall after an invalidate (defect 3).
7. No privileged/mutating process spawned: a `FakeCommandRunner`-backed test asserts only
   `ip` / `ipconfig.exe` / `netsh … show` / `ufw status` shapes are ever requested.
8. Full `NetworkStatus` shape unchanged (`network-manager.ts:189-209`); the two existing
   `network.rs` tests that assert the deferred `None` are updated, not deleted.

### Definition of done + falsifier

```bash
grep -n '"/api/lan-info"' crates/freshell-server/src/network.rs     # must hit
grep -n 'raw_port_open: None' crates/freshell-server/src/network.rs # must NOT hit
cargo test -p freshell-server -p freshell-platform
git log -1 --stat                                                    # non-empty code diff
```

### NET evidence

- **NET-01** (complete live status: reachability real, live bind, LAN/hostname, firewall) — primary.
- **NET-03** (accurate share URL; token percent-encoded via existing `access_url`, never logged — add a log-scan assertion).
- **NET-10** (native Linux addresses + `ufw` guidance as data only) — primary.
- Partial **NET-08** (auth gate on both read endpoints, via the shared layer).

---

## Slice 2 — Mutation endpoints, Linux-live

**Theme:** `POST /api/network/configure` and `POST /api/network/disable-remote-access`
really expose and really retract, transactionally, through the serialized config store.

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | Both POST routes; request validation; settings broadcast |
| `crates/freshell-server/src/main.rs` | Restructure serving so the listener can be swapped (`:1353-1380`); own `BindState`; hand `broadcast_tx` to `NetworkState` |
| `crates/freshell-server/src/settings_store.rs` | Narrow `patch_network()` **or** reuse `patch()` — **no new persistence path**; NET-09 rides the existing serialized store |

### TS reference anchors

- `server/network-router.ts:431-446` — `POST /network/configure`: zod-parse → 400
  `{error:'Invalid request', details}`; `configure()` → `getStatus()` → respond
  `{...status, rebindScheduled}`; **then** `broadcastSettingsUpdated()` (`:105-112`) —
  the broadcast happens *after* `res.json`, deliberately.
- `server/network-router.ts:18-21` — `NetworkConfigureSchema`:
  `host: z.enum(['127.0.0.1','0.0.0.0'])`, `configured: z.boolean()`. **Not** `.strict()` —
  unknown keys are stripped, not rejected. Match exactly (the client sends exactly these two).
- `server/network-router.ts:448-615` — `POST /network/disable-remote-access`, incl. the
  `confirmedRepairInFlight` 409 pre-check (`:462-467`), `resolveRemoteAccessDisableAction`
  (`:322-378`), and `applyRemoteAccessDisabledState` (`:119-132`) which rebinds to
  `127.0.0.1` and clears managed state.
- `server/network-manager.ts:400-439` — `configure()`: `hostChanged` computed from the
  **actual** bind (`:406-415`) and forced `false` on wsl2 (`:413`: "On WSL, the listener
  stays on 0.0.0.0 and the saved host is only an intent flag"); `patchSettings` (`:417`);
  cache invalidation (`:419-421`); queued-rebind path (`:423-436`).
- `server/network-manager.ts:449-534` — `rebind()`: `prepareForRebind()` → `server.close()`
  → `listen(port, newHost)`; on failure roll back to `oldHost`, revert the persisted host,
  rebuild origins, re-broadcast; `:477-483` the **CATASTROPHIC** branch where the rollback
  bind also fails and the server ends with **no listener**.

### The one deliberate deviation: make the rebind actually transactional

NET-02 requires "update persistence only after the new listener is proven". **The reference
does the opposite**: `network-manager.ts:417` persists via `patchSettings` *before* the
rebind is even scheduled, and `rebind()` (`:449`) closes the old listener *before*
attempting the new bind — leaving a window where a squatter takes the port and both the new
bind and the rollback fail, which the code itself labels
`'CATASTROPHIC: Rollback bind also failed — server has no active listener'` (`:480`). That
is an objectively defective shape (self-asserted invariant violation + total loss of
service), so per the user directive we **fix it in the port** and ledger the deviation
rather than replicating it.

**Verified experimentally on this kernel (prior session, re-confirm in Slice 2):**

| Experiment | Result |
|---|---|
| Bind `127.0.0.1:P`, then `0.0.0.0:P`, neither with `SO_REUSEPORT` | `EADDRINUSE` (98) |
| Both with `SO_REUSEPORT` | **both bind OK** |
| Loopback connection with both alive | delivered to the **more-specific `127.0.0.1`** listener |
| Non-`SO_REUSEPORT` squatter on `0.0.0.0:P`, then our `SO_REUSEPORT` bind | `EADDRINUSE` (98) — a foreign squatter still correctly blocks us |

So: **bind the new listener first (that IS the proof), then persist, then drain the old.**
Rollback becomes "drop the new socket" — a no-op that cannot fail. There is no window with
zero listeners, and no persisted state that outran reality.

Implementation: create listeners via `socket2` (already in `Cargo.lock:4358`, v0.6.4) with
`SO_REUSEPORT` + `SO_REUSEADDR` on **both** the boot listener and every rebind listener,
then `TcpListener::from_std`. Serving moves from a single `axum::serve(listener, app)`
(`main.rs:1375`) to one `axum::serve(...).with_graceful_shutdown(...)` task **per listener**,
each with its own `Notify`; `BindState` holds the current host + the live listener task's
shutdown handle. Process shutdown triggers all of them.

**Documented trade-off (goes in the deviation entry):** `SO_REUSEPORT` lets another process
*of the same effective UID* bind the same port and take a share of connections. On Linux the
same-EUID restriction puts this inside the same trust boundary as the auth token on a
single-user self-hosted box. Escape hatch: `FRESHELL_REBIND_NO_REUSEPORT=1` selects the
TS-faithful close-then-bind-with-rollback path (including its catastrophic branch), so the
old behavior stays reachable.

→ **Propose `DEV-00NN` in `port/oracle/DEVIATIONS.md`** (status `proposed`; the antagonist
adjudicates, never the implementer — `DEVIATIONS.md:8`). objective_defect: *breaks an
invariant the code itself asserts* + loss-of-service, evidence
`server/network-manager.ts:477-483`. pinning_test: the squatter test (Acceptance 4).

**WS handling during rebind.** The Rust WS layer has no `prepareForRebind`; it has a
per-connection shutdown arm driven by `WsState.shutdown`. Because the new listener is up
*before* the old drains, existing sockets on the old listener can drain naturally rather
than be force-closed — strictly better UX than the reference's mass 4009. If a socket must
be dropped (old listener's graceful-shutdown deadline) it gets the same 4009 the client
already handles. **Do not** reuse the process-wide `shutdown` `Notify` for this (it would
kill terminals) — the per-listener `Notify` is separate.

### `POST /api/network/configure` — behavior

1. Auth (shared layer) → 401 else.
2. Parse body; on failure 400 `{error:'Invalid request', details:[…]}` (zod-shaped issues).
   `host` accepts **only** the two literals — this is the NET-08 arbitrary-host defense and
   it is *structural*: the value reaching the socket layer is an enum, so no attacker string
   can ever reach a bind call or a command runner.
3. Compute `host_changed` from the **live** bind (`BindState`), forced `false` on wsl2
   (`network-manager.ts:413`).
4. If changed: **bind the new listener and prove it** (start serving on it). On bind failure
   → 500, **nothing persisted, old listener untouched** (NET-02's "occupy the target address
   to force failure" case).
5. Persist `{network:{host, configured}}` through `SettingsStore` — the same serialized
   store, same lock + atomic tmp+rename + adopt-from-disk merge. **NET-09 rides this store;
   no new writer.**
6. Invalidate the facts cache; update `BindState`; drain the old listener.
7. Respond `{...status, rebindScheduled}`. The reference computes `getStatus()` *after*
   `configure()` (`network-router.ts:438`) and the client tolerates a desired-state answer
   (`src/store/networkSlice.ts:59-95` polls `rebinding` up to 10×1s). Because our rebind is
   synchronous-and-proven, we answer with the **settled truth** and `rebindScheduled: false`;
   the client's polling loop is then a no-op. (Contract check: `networkSlice.ts:123-130`
   sets `rebinding:true` locally only when `rebindScheduled` — answering `false` with a
   settled status is contract-legal and strictly better.)
8. Broadcast `{"type":"settings.updated","settings":<full tree>}` on `broadcast_tx` after
   responding (`network-router.ts:445`; same mechanism as `settings_store.rs`'s patch route).

### `POST /api/network/disable-remote-access` — behavior

Body schema is `ConfigureFirewallRequestSchema` (`network-router.ts:23-26`) —
`{confirmElevation?: true, confirmationToken?: string}`, **`.strict()`** (unknown keys → 400).

On this WSL2 host the resolution ladder (`network-router.ts:322-378`) lands as:
- `firewall.platform === 'wsl2'` → `computeWslPortForwardingTeardownPlanAsync`. Inputs come
  from read-only `netsh … show`. If the plan is `Ready` the reference returns a
  **confirmable** action requiring elevated PowerShell → **HOST-BLOCKED**: we return the
  confirmation response (data only) and **never** elevate. If `noop`/`disabled`/`not-wsl2`
  → `{method:'none', message:'Remote access disabled'|'Remote access is not enabled'}` and,
  on the success message, `applyRemoteAccessDisabledState` (`:119-132`) runs — which is the
  **live Linux path we do implement**: rebind to `127.0.0.1` + persist + broadcast.
- native Linux / macOS (the NET-10 lane) → `{method:'none'}` plus the same rebind-to-loopback.

**Verified teardown (NET-06)** means: after the response, the loopback listener is up
(tier a still 200) *and* the 0.0.0.0 listener is gone (tier b REFUSED). Do not claim
completion before the old listener is actually drained — the response is emitted **after**
the drain, not before. Only Freshell-managed state is touched: our own socket and our own
`settings.network` key. **No portproxy or firewall rule is read-modified, and none is ever
deleted** — that whole branch is Slice 3's fake-backed machinery.

`FRESHELL_DISABLE_WSL_PORT_FORWARD=1` (`port_forward.rs:254`) is the harness's supported way
to force the WSL2 teardown/repair planners to `disabled` so the live Linux path runs
deterministically with zero `netsh` queries.

### Acceptance criteria

1. `configure {host:'0.0.0.0',configured:true}` → 200; status shows `host:'0.0.0.0'`,
   `portOpen:true`; **tier (b) 200**; tier (c) 200 **or documented degradation** (§0.3).
2. `disable-remote-access {}` → 200 `{method:'none',…}`; status shows `host:'127.0.0.1'`,
   `portOpen:null`; **tier (b) REFUSED**; tier (c) REFUSED or documented degradation;
   **tier (a) still 200**.
3. Round-trip idempotent and repeatable ×3 with no port leak (`ss -ltn` shows exactly one
   listener on the port at every settled point).
4. **Squatter test (NET-02's explicit case):** occupy the target address with a foreign
   non-`SO_REUSEPORT` listener → `configure` → 500, **old listener still serving**, config
   **unchanged on disk**; free the port and retry → succeeds.
5. **NET-09 byte-preservation:** seed `config.json` with sentinels in `sessionOverrides`,
   `terminalOverrides`, `serverSecrets`, and any other top-level keys present; toggle remote
   access; restart; assert `network` changed as chosen and **every other top-level key is
   byte-identical** (sha256 per key).
6. `settings.updated` broadcast after each successful mutation, carrying the full tree.
7. Every mutation 401s without auth and 400s on a malformed body, with **zero**
   listener/config change (assert both).
8. Crash-safety: `kill -9` mid-configure never leaves a state with no listener on restart
   (config is either old or new, both bindable).

### Definition of done + falsifier

```bash
grep -n '"/api/network/configure"' crates/freshell-server/src/network.rs             # must hit
grep -n '"/api/network/disable-remote-access"' crates/freshell-server/src/network.rs # must hit
cargo test -p freshell-server -p freshell-platform
```

### NET evidence

- **NET-02** (transactional configure/rebind) — primary, *exceeding* the reference.
- **NET-06** (safe disable, verified teardown, loopback preserved) — primary for the Linux
  lane; the Windows/WSL2 managed-rule teardown remains HOST-BLOCKED (Slice 3).
- **NET-09** (lossless writes through the serialized store) — primary.
- **NET-01/03** (status + share URL stay truthful across the transition).
- **NET-08** (auth + validation + arbitrary-host rejection on both mutations).

---

## Slice 3 — Firewall endpoint + Windows machinery behind fakes

**Theme:** `POST /api/network/configure-firewall` with the complete confirmation-token
protocol, plus WSL2 portproxy planning — with **every** OS mutation behind the injected
`CommandRunner`, and the real-runner path for Windows mutation **structurally unreachable
on this host**.

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | The `configure-firewall` route; wire `ConfirmationGate`; the shared action-resolution ladder used by this **and** `disable-remote-access` |
| `crates/freshell-platform/src/elevated.rs` | Extend `ConfirmationGate` (`:137-266`) with the reference's *fresh re-check under the lock* and the denial/timeout/partial outcomes |
| `crates/freshell-platform/src/port_forward.rs` | Runner-backed plan assembly (read-only `show` queries); builders already exist (`:413`, `:473`) |
| `crates/freshell-platform/src/firewall.rs` | Managed-port staleness read (`get_existing_managed_windows_firewall_ports`, `:313`) feeding `stale` |
| new small module | Managed-Windows-ports persistence (`network-manager.ts:111-137`), fake-backed |

### TS reference anchors

- `server/network-router.ts:617-758` — the route.
- Confirmation machinery: `issueConfirmation` `:218-228`; `matchesConfirmation` `:230-235`;
  `consumeConfirmation` `:237-244`; `consumeCurrentConfirmation` `:95-103`;
  `acquireConfirmedRepairLock` `:246-262`; `confirmedRepairInFlight` pre-checks `:624-629`
  **and** `:653-658` (checked twice — before and after action resolution, because resolution
  awaits); the **fresh re-check under the lock** `:672-700` (re-reads status+settings and
  re-resolves the action, so a token confirmed against stale facts cannot execute a stale
  script).
- `startElevatedRepair` `:150-216` — spawn, `setFirewallConfiguring(true)`, the
  `verifySuccess` → `onSuccess` → `settleRepair` chain, and the `child.on('error')` path.
- `resolveRepairAction` `:264-320`; verifiers `:380-410`.
- `ConfigureFirewallRequestSchema` `:23-26` (`.strict()`).
- **Client contract:** `src/lib/firewall-configure.ts:3-14` (the exact
  `ConfigureFirewallResult` union) and `:38-49` (409 + `method:'in-progress'` is caught and
  normalized, so the 409 body **must** carry `method:'in-progress'`);
  `NetworkSettings.tsx:238-268` (result dispatch), `:332-353` (confirm → re-POST with
  `{confirmElevation:true, confirmationToken}`).

### Behavior on this host

`resolveRepairAction` on WSL2 with remote access requested and `portOpen !== true` returns a
**confirmable** `wsl2-repair`. Our route:

1. Auth → 401; strict-parse → 400.
2. `repair_in_flight` → 409 `{error:'Firewall configuration already in progress', method:'in-progress'}`.
3. No/mismatched token → 200 `{method:'confirmation-required', title, body, confirmLabel,
   confirmationToken}` — a fresh UUID bound to the action. **No OS call.**
4. Matching token → acquire lock (lose the race → 409) → **re-resolve against fresh facts**
   → consume the token (single-use, constant-time compare per Slice 0/NET08-C) → dispatch
   the script through the injected runner.
5. On this Linux host the injected runner for the Windows/elevated path is **not** the real
   `StdCommandRunner` — see structural unreachability below.
6. `none`/`terminal` outcomes return their reference bodies; `terminal` (native Linux `ufw`)
   returns the guidance command string and the client opens a terminal tab
   (`NetworkSettings.tsx:251-258`) — **the server never runs it** (NET-10).

**Structural unreachability of the real Windows mutation path.** Not a runtime `if`, a type:
the elevation dispatcher is constructed with an `ElevationRunner` enum whose real variant is
built **only** under `#[cfg(windows)]`; on non-Windows the constructor can only produce
`ElevationRunner::Unsupported`, which returns a `not-supported` outcome without touching a
process. A compile-time test (`#[cfg(not(windows))]`) asserts the real variant cannot be
constructed, and a runtime test asserts `FakeCommandRunner::call_count() == 0` for every
path this Linux host can reach. This is stronger than "we promise not to call it" and
satisfies `port/HANDOFF.md:192-193` **by construction**.

**NET-07 semantics behind fakes.** Four outcomes as explicit variants driven by scripted
`FakeCommandRunner` responses, each with a golden test:
- **denial** (UAC cancelled → non-zero exit / "The operation was canceled by the user"):
  release the lock, `setFirewallConfiguring(false)`, **no persisted claim of success**,
  status reconciled from a fresh read.
- **timeout** (`ELEVATED_POWERSHELL_TIMEOUT_MS = 120_000`, `elevated.rs:18`): same, plus a
  distinguishable log/outcome.
- **partial success** (exit 0 but `verifySuccess` still finds work outstanding —
  `network-router.ts:380-404` throws): treated as **failure**, not success; nothing persisted.
- **verification failure** on the disable side (`verifyWindowsDisableSuccess` `:406-410`).

In all four: the lock is released exactly once (idempotent, `:252-261`), the confirmation is
consumed (no replay), and the next status read is authoritative.

**NET-05 (WSL2 portproxy planning).** Plan builders already exist (`port_forward.rs:413`,
`:473`) with the script normalizer (`:264`). Slice 3 wires the **read-only** inputs —
`get_wsl_ip` (`:549`), `get_existing_port_proxy_rules` (`:565`),
`get_existing_firewall_ports` (`:578`) — with `wsl_ip` now an `Ipv4Addr` (Slice 0), and
asserts the produced script byte-for-byte against goldens. The script is
**returned/logged, never executed**. A golden test pins the plan produced from *this host's
real, captured* `netsh interface portproxy show all` output (**14 rules** as captured
2026-08-02, including `0.0.0.0:3001 -> 172.30.149.249:3001` and
`0.0.0.0:3412 -> 172.30.149.249:3412`) — proving the planner recognizes the pre-existing
3001 rule as already-satisfying and would emit **no** add for it.

**NET-04 managed rules + staleness.** `managed_windows_firewall_rule_name` (`firewall.rs:230`)
= `Freshell (port N)`; add/delete/repair builders `:248/:261/:278`. Wire the `stale`
parameter that Slice 1 turned into an input, driven by
`get_existing_managed_windows_firewall_ports` (`:313`) over a fake. Golden test: the
real `FreshellLANAccess` rule captured from this host (scoped `LocalPort: 3001`) and an
unrelated sentinel rule name are **never** in any delete command (the checklist's "unrelated
sentinel rule survives").

### Acceptance criteria

1. First POST (no token) → 200 `confirmation-required` with a fresh UUID;
   `FakeCommandRunner` call count **0**.
2. Second POST with that token → the action proceeds through the **fake**; response is
   `{method:'wsl2'|'windows-elevated', status:'started'}`.
3. **Replay:** re-POST the same token → a *new* `confirmation-required` (token consumed),
   never a second execution.
4. **Wrong-action token:** a token issued for `wsl2-repair` presented to
   `disable-remote-access` (`wsl2-disable`) → re-issue, never execute
   (`matchesConfirmation` is action-bound, `:230-235`).
5. **Concurrency:** two confirmed requests in flight → exactly one proceeds, the other gets
   409 with `method:'in-progress'`; the lock is released exactly once.
6. **Stale-facts race:** facts change between issue and confirm → the under-lock
   re-resolution produces a different action → re-issue, never execute the stale script.
7. NET-07 matrix (denial/timeout/partial/verification-failure): each leaves
   `firewall.configuring === false`, no false persisted success, and a subsequent success
   after switching the fake to a good response.
8. Golden strings byte-exact for: elevated arg wrapping (`elevated.rs:24`), Windows
   add/delete/repair, WSL2 full + firewall-only + teardown scripts.
9. **Zero real OS mutation**: aggregate assertion across the slice's suite that no
   `netsh … add|delete|set`, no `Start-Process -Verb RunAs`, and no `ufw`/`iptables` ever
   reached a real runner; plus the compile-time unreachability test.

### Definition of done + falsifier

```bash
grep -n '"/api/network/configure-firewall"' crates/freshell-server/src/network.rs  # must hit
cargo test -p freshell-server -p freshell-platform
# and the read-only host-state diff (must be identical to the pre-slice capture):
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile \
  -Command "netsh interface portproxy show all"
```

### NET evidence

- **NET-04** — implemented + golden-tested; **live effects HOST-BLOCKED (deferred-with-evidence)**.
- **NET-05** — planner implemented + golden-tested against real captured host output; **live effects HOST-BLOCKED**.
- **NET-07** — all four failure modes implemented + tested behind fakes; **live elevation HOST-BLOCKED**.
- **NET-08** — token single-use, action-bound, constant-time, replay-rejected, overlapping-op 409 — primary.
- **NET-10** — the `terminal`/`ufw` guidance branch returns data and never executes.

> **HOST-BLOCKED declaration.** NET-04, NET-05, and NET-07 require a disposable **elevated
> Windows VM** (`PW-TAURI-WIN` + `HARNESS-09`), which this host is not, and which
> `port/HANDOFF.md:192-193` forbids simulating by executing real mutations. They are marked
> **deferred-with-evidence**: implementation complete, golden/fake-backed tests green, live
> effect unexecuted **by design**. This matches their **H** classification in
> `docs/plans/2026-07-18-checklist-reconciliation.md:258-262`. Do **not** check these boxes;
> record the evidence and the block in
> `docs/plans/2026-07-28-net-windows-deferred-evidence.md` (the artifact the prior run's
> `windows_defer` stage was supposed to produce and did not).

---

## Harness spec — `scripts/verify-remote-access.sh`

One self-contained bash script. Boots the built Rust server with an isolated `HOME`,
exercises all five endpoints (auth positive + negative), proves expose/retract on the
three-tier vantage ladder, runs the NET-08 negative matrix, reaps everything it started, and
**exits 0 only if every required check passes**.

**Design rule born from the prior run:** the harness must fail loudly rather than be
absent-and-reported-green. Phase 0 exits non-zero on any missing precondition, and the
converge gate checks `test -x scripts/verify-remote-access.sh` as a criterion in its own
right.

### Invocation & options

```
scripts/verify-remote-access.sh [--port N] [--tier-c] [--keep-home] [--verbose]
```

**Default port: an ephemeral free high port** (probed, not hardcoded) — *changed from the
prior plan's 3001*, because 3001 is now the live production server (§0.3). `--tier-c` opts
into the true-LAN tier and is only honored with `--port 3001` **and** only if nothing is
already listening there. Writes a machine-readable summary to
`/tmp/freshell-verify-remote-access-<pid>/report.json` plus a human summary on stdout.

### Phase 0 — preflight (fail fast, before starting anything)

1. `set -euo pipefail`; `trap cleanup EXIT INT TERM`.
2. Assert `target/release/freshell-server` exists and is newer than the crate sources (else
   `cargo build --release -p freshell-server`).
3. **Refuse to touch the live server.** Hard error if the requested port is currently
   listening at all. Specifically: if `--port 3001` and pid 64553 (or any pid not started by
   this script) holds it → abort with a message naming the pid and its cwd. Never kill a pid
   this script did not start; ownership-verify via `/proc/<pid>/cwd` + cmdline before any kill.
4. `WSL_IP="$(ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+')"` — **re-resolved every run**,
   never read from `.verify-vantages.env`. Empty ⇒ tier (b) unavailable ⇒ **hard fail**
   (tier (b) is REQUIRED).
5. Tier (b) liveness: `powershell.exe -NoProfile -Command "echo ok"` must succeed.
6. **Tier (c) gating** (all read-only, per §0.3):
   - **Unconditional sanity control:** `ssh -o BatchMode=yes -o ConnectTimeout=8
     shapiroserver2 "curl -s -o /dev/null -w '%{http_code}' --max-time 6
     http://192.168.3.50:3001/api/health"` → record the code (measured **200** on
     2026-08-02). This proves the LAN vantage is alive without binding anything. A non-200
     here is recorded as `tier_c_vantage: unavailable` (a note, not a failure).
   - If `--tier-c` was **not** passed, or the port ≠ 3001: **DEGRADE tier (c)** with the
     reason `firewall allow scoped to 3001 only (FreshellLANAccess LocalPort=3001); harness
     port <N> may not open a new rule (safety rule 6)`.
   - If `--tier-c` **was** passed with port 3001: additionally require (i) nothing listening
     on 3001, (ii) a portproxy rule `0.0.0.0 3001 -> <WSL_IP> 3001` present via read-only
     `netsh interface portproxy show all`, and (iii) its connect-address equals the current
     `WSL_IP`; a mismatch **DEGRADES** with `portproxy target <old> != current eth0 <new>`.
   - `netsh … show` (portproxy + `advfirewall firewall show rule`) is the **only** permitted
     `netsh` use, and it is read-only.
7. Isolated home: `HOME_DIR=$(mktemp -d)`; seed `$HOME_DIR/.freshell/config.json` with the
   full sentinel set (`version`, `settings`, `sessionOverrides`, `terminalOverrides`,
   `serverSecrets`, plus every other top-level key the real store writes) and record its
   sha256 **per top-level key**.
8. `AUTH_TOKEN=$(openssl rand -hex 32)`; never echoed, never written to the report.
9. **Capture the read-only host network state** (portproxy table + `FreshellLANAccess` rule)
   for the Phase-7 identity diff.

### Phase 1 — boot

Start with `HOME=$HOME_DIR FRESHELL_HOME=$HOME_DIR AUTH_TOKEN=… PORT=$PORT
FRESHELL_DISABLE_WSL_PORT_FORWARD=1 target/release/freshell-server`, log to the temp dir,
pid to `$TMP/server.pid`. Wait for `/api/health` (unauthenticated) up to 20s. Record the
pid's `/proc/<pid>/cwd` + cmdline so cleanup can **ownership-verify** before killing.

`FRESHELL_DISABLE_WSL_PORT_FORWARD=1` keeps the WSL2 teardown/repair planners in `disabled`,
so the harness exercises the **live Linux rebind path** deterministically and issues zero
`netsh` queries of its own.

### Phase 2 — endpoint surface (auth positive + negative)

For each of the five endpoints, with and without `X-Auth-Token`:

| Endpoint | Method | Authed | Unauthed |
|---|---|---|---|
| `/api/lan-info` | GET | 200 `{ips:[…]}` | 401 `{"error":"Unauthorized"}` |
| `/api/network/status` | GET | 200 full `NetworkStatus` shape | 401 |
| `/api/network/configure` | POST | 200 | 401 |
| `/api/network/disable-remote-access` | POST | 200 | 401 |
| `/api/network/configure-firewall` | POST | 200 | 401 |

The status shape check asserts **every** key of `NetworkStatus`
(`server/network-manager.ts:189-209`) is present with the right JSON type, and that the
content-type is `application/json; charset=utf-8`.

### Phase 3 — expose sequence

1. `POST /api/network/configure {"host":"0.0.0.0","configured":true}` → 200.
2. `GET /api/network/status` → `host == "0.0.0.0"`, `firewall.portOpen == true`,
   `remoteAccessEnabled == true`.
3. **Tier (a)** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/` → `200`.
4. **Tier (b)** `powershell.exe -NoProfile -NonInteractive -Command "…Invoke-WebRequest
   -UseBasicParsing -TimeoutSec 5 http://$WSL_IP:$PORT/…"` → `STATUS 200`. **REQUIRED.**
5. **Tier (c)** (only when enabled per Phase 0.6) `ssh shapiroserver2 "curl -s -o /dev/null
   -w '%{http_code}' --max-time 6 http://192.168.3.50:3001/"` → `200`; otherwise record the
   degradation note and continue.

### Phase 4 — retract sequence

1. `POST /api/network/disable-remote-access {}` → 200, body has `method`.
2. `GET /api/network/status` → `host == "127.0.0.1"`, `portOpen == null`,
   `remoteAccessEnabled == false`.
3. **Tier (b)** → **REFUSED** (`Unable to connect` / non-200). **REQUIRED.**
4. **Tier (c)** → **REFUSED** (`000`), or documented degradation.
5. **Tier (a)** → still `200` (loopback survives — the NET-06 core claim).
6. `ss -ltn | grep ":$PORT "` → exactly one listener, bound `127.0.0.1`.

### Phase 5 — restart / NET-09 byte preservation

1. SIGTERM the owned pid; wait for exit (bounded, ownership-verified, never a blind SIGKILL).
2. Diff `config.json`: `settings.network` reflects the chosen state; **every other
   top-level key byte-identical** to the Phase-0 sentinels (sha256 per key).
3. Restart on the same isolated home; `GET /api/network/status` → the persisted state;
   tier (b) REFUSED (loopback persisted correctly across restart).

### Phase 6 — NET-08 negative matrix

Every case asserts **both** a correct rejection **and** zero side effects (config sha
unchanged, listener set unchanged, `ss` output unchanged):

| # | Case | Expected |
|---|---|---|
| 1 | Any mutation with no `X-Auth-Token` | 401, no change |
| 2 | Mutation with a wrong token | 401, no change |
| 3 | `configure` with `{}` / missing `host` / missing `configured` | 400 `Invalid request` |
| 4 | `configure` `{"host":"1.2.3.4","configured":true}` (arbitrary host) | 400 |
| 5 | `configure` `{"host":"0.0.0.0; rm -rf /","configured":true}` | 400 |
| 6 | `configure` `{"host":"$(id)","configured":true}` / backtick / `\|` / newline variants | 400 |
| 7 | `configure` `{"host":"0.0.0.0","configured":"yes"}` (type confusion) | 400 |
| 8 | `disable-remote-access` `{"unknownKey":1}` (strict schema) | 400 |
| 9 | `configure-firewall` `{"confirmElevation":false}` (literal-true only) | 400 |
| 10 | `configure-firewall` `{"confirmationToken":""}` (min 1) | 400 |
| 11 | **Token replay:** issue → confirm → confirm again | second is a *new* `confirmation-required`, never a second execution |
| 12 | **Wrong-action token** across the two endpoints | re-issue, never execute |
| 13 | **Concurrent confirmed ops** (two parallel confirmed POSTs) | exactly one proceeds; the other 409 with `method:'in-progress'` |
| 14 | Injection strings in `confirmationToken` | 400/re-issue; **never reaches a runner** |
| 15 | **Positive control:** one valid `configure` still succeeds after the whole matrix | 200 |

Cases 5/6/14 are additionally proved *structurally* by the Rust unit tests (`host` is an
enum; `wsl_ip` is an `Ipv4Addr`; `FakeCommandRunner::call_count() == 0`) — the harness
proves the black-box contract, the unit tests prove nothing reached a runner. Both are
required; neither substitutes for the other.

Also scan the server log for the auth token (NET-03: the secret must never be logged) → must
be absent.

### Phase 7 — cleanup & exit

1. Kill only the recorded pid, **after** verifying `/proc/<pid>/cwd` + cmdline match this
   worktree's `freshell-server` (never a pattern kill). **Never touch pid 64553 / port 3001.**
2. Assert no listener remains on `$PORT` (`ss -ltn`).
3. Remove the temp home unless `--keep-home`.
4. **Safety self-proof:** re-run the read-only `netsh interface portproxy show all` **and**
   `netsh advfirewall firewall show rule name=FreshellLANAccess`, and diff against the
   Phase-0 capture — **must be identical**. This is the harness's own evidence that it
   respected safety rule 6.
5. Exit `0` only if all required checks passed. Tier-(c) degradation is **not** a failure
   but **must** appear in the report as a `degraded` entry with its reason. Tier-(b) failure
   **is** a failure.

### Report

`report.json`:
```json
{ "port": N, "wsl_ip": "…",
  "tiers": {"a": {...}, "b": {...}, "c": {"status":"pass|degraded","reason":"…"}},
  "phases": [...], "net_items_evidenced": [...], "degradations": [...],
  "deferred_host_blocked": ["NET-04","NET-05","NET-07"],
  "host_state_unchanged": true, "passed": true }
```

---

## Cross-cutting: deviations to adjudicate

Record in `port/oracle/DEVIATIONS.md` (status `proposed`; the antagonist reviewer
adjudicates, never the implementer — `DEVIATIONS.md:8`):

1. **Transactional rebind (bind-new-before-persist, `SO_REUSEPORT`).** objective_defect:
   *breaks an invariant the code itself asserts* + loss of service —
   `server/network-manager.ts:477-483` (`'CATASTROPHIC: Rollback bind also failed — server
   has no active listener'`) and persistence-before-proof at `:417` vs NET-02's explicit
   requirement. port_behavior: prove the new listener first, then persist, then drain;
   rollback is an infallible socket drop. Escape hatch `FRESHELL_REBIND_NO_REUSEPORT=1`.
   pinning_test: the squatter test (Slice 2 acceptance 4).
2. **Settled-status response to `configure`.** The reference answers with a desired-state
   preview and makes the client poll (`networkSlice.ts:59-95`). Ours answers with settled
   truth and `rebindScheduled:false`. Contract-legal (the client treats it as a normal
   status) and strictly better. Low-risk, but ledger it so the differ doesn't flag it.
3. **No mass 4009 on rebind.** The reference force-closes every WS connection because it
   must close the listener first. With overlapping listeners we let old connections drain.
   Ledger as an intentional UX improvement.
4. **NET08-A/B/C hardening** (`Ipv4Addr` typing + constant-time token compare). Strictly a
   security improvement over the reference's string interpolation; ledger for completeness.

**Do not** replicate-as-bug: the reference's wsl2
`remoteAccessEnabled = rawPortOpen === true` (ignoring `remoteAccessRequested`,
`network-manager.ts:349-350`) looks odd but is the **client contract** —
`src/lib/share-utils.ts:17-21` and the WSL "reachability unknown" branch `:24-34` depend on
it. Keep it faithful; note it as *reviewed and deliberately kept*.

---

## Sequencing & definition of done

Slices are strictly ordered. Slice 0's type hardening is a prerequisite for Slice 3's
wiring (the audit is explicit that this is cheap now and an incident later). Slice 1's
live-state reshape is a hard prerequisite for Slice 2 (you cannot rebind against a frozen
`effective_host`), and Slice 2's action ladder is reused by Slice 3. Each slice is
Red-Green-Refactor with unit + integration coverage, **and is committed before the next
begins** (`AGENTS.md` Development Philosophy).

**Done** =

1. All three slices committed on `feat/remote-access-networking`, each with a non-empty code
   diff and its falsifier output in the commit message;
2. `git status --porcelain server/ shared/ src/` **empty** (frozen reference respected);
3. `cargo test -p freshell-server -p freshell-platform` green;
4. `test -x scripts/verify-remote-access.sh` **and** the script exits 0 with tiers (a)+(b)
   passing (tier (c) passing or explicitly degraded-with-reason);
5. `report.json` shows `host_state_unchanged: true`;
6. Deviation entries filed as `proposed`;
7. NET-01/02/03/06/08/09/10 evidenced; NET-04/05/07 recorded as **HOST-BLOCKED /
   deferred-with-evidence** in `docs/plans/2026-07-28-net-windows-deferred-evidence.md` and
   left **unchecked** in the completion checklist;
8. A re-run of the NET-08 audit against the **now-wired** routes (the existing audit
   explicitly disclaims coverage of them — `net08-security-audit.md:0` headline).
