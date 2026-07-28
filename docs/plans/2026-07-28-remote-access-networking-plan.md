# Remote-access networking on the Rust Freshell server — implementation plan

**Date:** 2026-07-28
**Branch:** `feat/rust-tauri-port` (work in a worktree; never commit to `main`)
**Goal:** make remote-access networking *work* on the Rust server — all five client-called
endpoints exist and behave, status is truthful, expose/retract is proven from real external
vantages, every mutation is secured (NET-08), and Windows-elevated behavior is implemented
behind injected runners with golden tests but **never executed**.

Scope map: NET-01…NET-10
(`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:502-532`), reconciliation
classes (`docs/plans/2026-07-18-checklist-reconciliation.md:253-266`). The checklist is the
map, not the goal: prioritize working behavior over checkbox parity.

---

## 0. Preconditions, invariants, and what was verified live

### 0.1 Hard safety invariants (every slice, no exceptions)

Per `port/HANDOFF.md:192-195` (safety rule 6):

1. **Never execute mutating Windows network/firewall commands** — no `netsh … add/delete`,
   no `netsh interface portproxy add/delete`, no elevated UAC (`Start-Process -Verb RunAs`).
   Mutation exists **only** as golden-string builders dispatched through an injected
   `CommandRunner`, which in every test is a `FakeCommandRunner`.
2. **Never execute privileged Linux commands** (`ufw`/`iptables`/`sudo`). NET-10 requires
   *guidance text*, not execution. `firewall_commands()` output stays data.
3. **Rebinding our own listener** (`127.0.0.1` ↔ `0.0.0.0`) is allowed and is the Linux live
   path — it is our own socket, not OS-global state.
4. **Read-only cross-boundary probes are allowed and expected**: `powershell.exe
   Invoke-WebRequest`, `netsh interface portproxy show all`, `ipconfig.exe`,
   `ssh shapiroserver2 curl`. Never create/modify a portproxy or firewall rule.
5. `server/`, `shared/`, `src/` are **frozen at `98ed121c`** (`port/HANDOFF.md:203`).
   `git diff` on them must stay empty. The client is the CONTRACT to satisfy, not code to edit.
6. Isolated `HOME` for every test server; reap every process started (ownership-verified).
7. **Never restart the live self-hosted server on port 3002** without the user's explicit
   "APPROVED". All harness servers run on their own ports with their own pid files.

### 0.2 Vantage ladder — verified live 2026-07-28 (in this working session)

| Tier | Vantage | Verified result |
|---|---|---|
| (a) | WSL loopback `curl http://127.0.0.1:$PORT/` | 200 against a 0.0.0.0-bound listener |
| (b) | Windows host: `powershell.exe Invoke-WebRequest http://<eth0 IP>:$PORT/` | **200** vs 0.0.0.0-bound; **"Unable to connect to the remote server"** vs 127.0.0.1-bound |
| (c) | True LAN: `ssh shapiroserver2 curl http://192.168.3.50:3001/` | **200** with a 0.0.0.0-bound listener on 3001; **000/refused** once it stopped |

**The decisive measurement that justifies tier (b):** with a listener bound to
`127.0.0.1:39221`, `powershell.exe … http://localhost:39221/` returned **200** (WSL
`localhostForwarding` lies), while `powershell.exe … http://172.30.149.249:39221/`
(current eth0 IP) returned **"Unable to connect"**. Therefore **tier (b) must target the
eth0 IP, never `localhost`** — that is the only cheap vantage where a 200 truthfully means
"0.0.0.0-bound" and a refusal truthfully means "loopback-bound". Tier (b) works on any port.

**Tier (c) preconditions** (both currently true; re-checked at harness start):
- Pre-existing Windows portproxy `0.0.0.0:3001 -> 172.30.149.249:3001` — confirmed present
  via read-only `netsh interface portproxy show all`, and its connect-address **matches the
  current eth0 IP** `172.30.149.249`.
- No legacy TS server holding 3001 (confirmed: `ss -ltn` shows no `:3001` listener; the live
  Rust server is on 3002).
If either preconditions fails, tier (c) **DEGRADES with a documented note** and the harness
continues on tiers (a)+(b). Tier (c) is valid **only on port 3001**.

`.verify-vantages.env` (already present, untracked) records the resolved facts; the harness
**re-resolves** `WSL_IP` at start via `ip -4 addr show eth0` rather than trusting the file
(the WSL IP changes across WSL restarts — that is exactly the tier-c degradation trigger).

### 0.3 Three defects found in the current Rust code (all must be fixed in Slice 1)

Discovered while reading `crates/freshell-server/src/main.rs:703-709` and `network.rs`:

1. **`NetworkState.settings` is a frozen boot snapshot.** `main.rs:194` does
   `let settings = Arc::new(settings_store.get().await)` and `main.rs:705` hands that
   `Arc<ServerSettings>` to `NetworkState`. After any settings mutation (including our own
   `POST /api/network/configure`), `GET /api/network/status` would keep reporting the
   **boot-time** `network.{configured,host}`. The reference reads the store on every call
   (`network-manager.ts:283`: `await this.configStore.getSettings()`). → must take
   `SettingsStore` (which `settings_store.rs` already exposes as a cheap-clone live handle).
2. **`effective_host` is frozen at boot** (`main.rs:706`: `Arc::new(bind_host.clone())`).
   The reference derives it from the **live** `server.address()` every call
   (`network-manager.ts:290-301`). After a rebind, a frozen value is a lie. → must be live
   shared state written by the rebind path.
3. **`facts: OnceCell` caches LAN IPs + firewall for the process lifetime.** The reference
   invalidates both on `configure` (`network-manager.ts:418-419`:
   `this.firewallInfo = null; await this.refreshLanIpsAsync()`) and exposes
   `resetFirewallCache()` (`:530-532`). A `OnceCell` cannot be invalidated. → must become a
   refreshable cache (`RwLock<Option<LiveNetworkFacts>>` + an explicit `invalidate()`).

These are port defects (the Rust side is wrong relative to the reference), **not** deviations
— no DEVIATIONS.md entry needed. They are the reason "unhardcode `remoteAccessEnabled`" is
not a one-line change.

---

## Slice 1 — Status truthfulness + `/api/lan-info`

**Theme:** make `GET /api/network/status` tell the truth on both bind paths, and add the
missing read endpoint. No mutation anywhere in this slice.

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | Live probe wiring; `NetworkState` reshape (live settings/host/facts); add `GET /api/lan-info`; keep `build_network_status` pure |
| `crates/freshell-platform/src/network.rs` | Add `detect_lan_ips_from_linux_interfaces()` (NET-10 native-Linux gap at `network.rs:243-249`); reuse existing `rank_lan_ip_candidates` (`:383`) + `prefix_len_to_netmask` (`:392`) |
| `crates/freshell-platform/src/lib.rs` | (if needed) nothing new — `CommandRunner`/`FakeCommandRunner` already sufficient |
| `crates/freshell-server/src/main.rs` | Pass `SettingsStore` + live bind-host handle + refreshable facts into `NetworkState` (`:703-709`) |
| `crates/freshell-platform/Cargo.toml` | No new deps (parse `ip -o -4 addr show` text via the existing injected runner) |

### TS reference anchors

- `server/network-router.ts:412-419` — `GET /lan-info` (`{ ips }`, 500 `{error:'Failed to get LAN info'}`).
- `server/network-router.ts:421-429` — `GET /network/status` (raw status, 500 on error).
- `server/network-manager.ts:282-398` — `getStatus()`; specifically:
  - `:290-301` effective-host derivation from the **live** `server.address()`, with the
    `!configured && HOST env` fallback when not yet listening;
  - `:303-320` the reachability probe: **only when `effectiveHost === '0.0.0.0'` and
    `lanIps.length > 0`**, `isPortReachable(port, { host: lanIps[0], timeout: 2000 })` per
    remote-access port; any `false` → `false`, else any `null` → `null`, else `true`;
  - `:325` `remoteAccessRequested = isRemoteAccessEnabled(...)`;
  - `:343` `portOpen = staleManagedWindowsExposure ? false : rawPortOpen`;
  - `:349-352` `remoteAccessEnabled` (wsl2: `rawPortOpen === true`; else
    `requested && rawPortOpen === true`);
  - `:353-361` `remoteAccessNeedsRepair`; `:362-369` `shareRouteEnabled`;
  - `:370-375` `accessUrl`; `:377-397` the returned `NetworkStatus` shape (`:189-209`).
- `server/network-access.ts:6-19` — `isRemoteAccessEnabled` (already ported at
  `freshell-platform/src/network.rs:94`).
- `server/bootstrap.ts:94-105` `collectLanIpCandidates`, `:151-153`
  `detectLanIpsFromInterfaces`, `:182-196` `detectLanIps` — the native path the Rust side
  currently stubs to `Vec::new()`.

### Design

**Probe (the core of NET-01).** One implementation covers both paths because both are a plain
TCP connect:

```rust
async fn probe_port_reachable(host: &str, port: u16, timeout: Duration) -> Option<bool>
```
`tokio::net::TcpStream::connect((host, port))` under `tokio::time::timeout(2s)`:
`Ok(_)` → `Some(true)`; connect refused/unreachable → `Some(false)`; timeout or
resolution/other error → `None` (the reference's `catch → null`, `network-manager.ts:311`).

Gate it exactly as the reference does: **run the probe only when `effective_host == "0.0.0.0"`
and `lan_ips` is non-empty.** On a loopback bind, `raw_port_open` stays `None` — that is not
a deferral, it is the reference's own value (`network-manager.ts:303`), so the loopback path
is loopback-faithful by construction. This deletes the `raw_port_open: None` deferral comment
at `network.rs:122-123` and the module-doc paragraph at `network.rs:26-34`.

Note what `lan_ips[0]` means per platform, because it makes the probe meaningful on both:
- **WSL2:** `lan_ips[0]` is the *Windows host's* physical LAN IP (`ipconfig.exe`,
  `bootstrap.ts:113-124`), e.g. `192.168.3.50`. Probing it from inside WSL traverses the
  Windows portproxy + firewall — so `portOpen === true` genuinely means "the whole WSL2
  exposure chain works". **Verified live:** with a 0.0.0.0 listener on 3001,
  `curl http://192.168.3.50:3001/` from WSL returned 200.
- **Native Linux:** `lan_ips[0]` is this host's own LAN IP → a non-loopback self-connect,
  which is precisely the bind-address truth test.

**Native-Linux LAN detection (NET-10).** `network.rs:243-249` currently returns `Vec::new()`
for non-WSL Linux, which *also* disables the probe there (empty `lan_ips` ⇒ no probe). Fix in
`freshell-platform`: `detect_lan_ips_from_linux_interfaces(runner)` runs read-only
`ip -o -4 addr show`, parses `<ifname> inet <addr>/<prefix>`, drops `lo`/loopback and
`scope host`, converts prefix→netmask with the existing `prefix_len_to_netmask`, and ranks
with the existing `rank_lan_ip_candidates` — i.e. byte-identical ranking to
`bootstrap.ts:94-105 + :151-153`. Golden test uses the real captured output of
`ip -o -4 addr show` from this host (13 interfaces incl. `docker0 172.17.0.1` which
`score_lan_ip` must score 0, and 8 `br-*` bridges) and asserts the ranked order.

**Unhardcode `remoteAccessEnabled` / `needsRepair`.** These are already *derived* correctly in
the pure `build_network_status` (`network.rs:171-183`); they read `false` only because
`raw_port_open` is always `None` and `stale` is hardcoded `false` (`network.rs:160`). Feeding
the real probe result fixes both. `stale` (Windows managed-port staleness) stays `false` on
this host and is explicitly **HOST-BLOCKED** (see §Slice 3) — but it becomes a *parameter*
now, not a literal, so Slice 3's Windows machinery can drive it under test.

**Live state reshape.** `NetworkState` becomes:
```rust
pub struct NetworkState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,                      // live, was Arc<ServerSettings>
    pub bind: Arc<BindState>,                         // live effective host (see Slice 2)
    pub port: u16,
    pub facts: Arc<NetworkFactsCache>,                // refreshable, was OnceCell
}
```
`BindState` in Slice 1 is read-only (`RwLock<String>` seeded from `resolve_bind_host()`);
Slice 2 gives it the writer. `NetworkFactsCache` = `RwLock<Option<LiveNetworkFacts>>` +
`get_or_refresh()` + `invalidate()`; the read-only subprocesses still run under
`spawn_blocking`.

**`GET /api/lan-info`.** Mounted in the same `network::router()` behind the same
`is_authed` gate (`boot.rs:686`) / `unauthorized()` (`boot.rs:713`), returning
`{"ips": [...]}` from the same cached facts. On detection failure the reference returns
500 `{"error":"Failed to get LAN info"}` (`network-router.ts:415-418`); our detection is
infallible-with-empty-vec, so 500 is unreachable — note it, do not fabricate a failure path.

### Acceptance criteria

1. `GET /api/lan-info` returns `{"ips":[...]}` with 200 + `application/json; charset=utf-8`;
   401 `{"error":"Unauthorized"}` with no/bad token; contents equal the `lanIps` in
   `GET /api/network/status` from the same process.
2. With the server bound `0.0.0.0` on a host with a LAN IP: `firewall.portOpen === true`,
   `remoteAccessEnabled === true` (non-wsl2 requires `remoteAccessRequested` too),
   `remoteAccessNeedsRepair === false`, `accessUrl` host is `lanIps[0]`.
3. With the server bound `127.0.0.1`: `firewall.portOpen === null` (reference-faithful, not
   an invented `false`), `remoteAccessEnabled === false`, `accessUrl` host is `localhost`.
4. **Negative-truth test (the one that matters):** with a 0.0.0.0 bind but the port
   deliberately unreachable from `lanIps[0]` (fixture-injected probe result `Some(false)`),
   `portOpen === false` and `remoteAccessNeedsRepair === true` on wsl2/windows.
5. Native Linux (`ip -o -4 addr show` golden): `lanIps` non-empty and correctly ranked;
   `172.17.0.1` (docker) sorts last; loopback absent.
6. Status reflects a settings change made after boot (proves defect #1 fixed) and a bind
   change (proves #2), and `lanIps`/firewall re-detect after an invalidate (proves #3).
7. No privileged/mutating process is spawned: a `FakeCommandRunner`-backed unit test asserts
   only `ip`/`ipconfig.exe`/`netsh … show`/`ufw status` shapes are ever requested.
8. Full `NetworkStatus` shape unchanged (`network-manager.ts:189-209`); existing
   `network.rs` tests still pass (update the two that assert the deferred `None`).

### NET evidence

- **NET-01** (complete live status: reachability now real, live bind, LAN/hostname, platform/firewall) — primary.
- **NET-03** (accurate share URL; token percent-encoded via existing `access_url`, never logged — add a log-scan assertion).
- **NET-10** (native Linux addresses + `ufw` guidance as data only) — primary.
- Partial **NET-08** (auth gate on both read endpoints).

---

## Slice 2 — Mutation endpoints, Linux-live

**Theme:** `POST /api/network/configure` and `POST /api/network/disable-remote-access` really
expose and really retract, transactionally, through the serialized config store.

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | Both POST routes; request validation; settings broadcast |
| `crates/freshell-server/src/main.rs` | Restructure serving so the listener can be swapped (`:999-1024`); own `BindState`; hand `broadcast_tx` to `NetworkState` |
| `crates/freshell-server/src/settings_store.rs` | Add a narrow `patch_network()` (or reuse `patch()`) — **no new persistence path**; NET-09 rides the existing serialized store |
| `crates/freshell-platform/src/network.rs` | (read-only) reuse `is_remote_access_enabled` |

### TS reference anchors

- `server/network-router.ts:431-446` — `POST /network/configure`: zod-parse → 400
  `{error:'Invalid request', details}`; `configure()` → `getStatus()` → respond
  `{...status, rebindScheduled}`; **then** `broadcastSettingsUpdated()` (`:105-112`) —
  note the broadcast happens *after* `res.json`, deliberately.
- `server/network-router.ts:18-21` — `NetworkConfigureSchema`:
  `host: z.enum(['127.0.0.1','0.0.0.0'])`, `configured: z.boolean()`. **Not** `.strict()` —
  unknown keys are stripped, not rejected (match this exactly; the client sends exactly these two).
- `server/network-router.ts:448-615` — `POST /network/disable-remote-access`, incl. the
  `confirmedRepairInFlight` 409 pre-check (`:462-467`), `resolveRemoteAccessDisableAction`
  (`:322-378`), and the `applyRemoteAccessDisabledState` path (`:119-132`) that rebinds to
  `127.0.0.1` and clears managed state.
- `server/network-manager.ts:400-438` — `configure()`: `hostChanged` is computed from the
  **actual** bind (`:405-413`) and is forced `false` on wsl2 (`:413`: "on WSL the listener
  stays on 0.0.0.0 and the saved host is only an intent flag"); `patchSettings` (`:417`);
  cache invalidation (`:419-421`); queued-rebind path (`:423-435`).
- `server/network-manager.ts:449-530` — `rebind()`: `prepareForRebind()` →
  `server.close()` → `listen(port, newHost)`; on failure roll back to `oldHost`, revert the
  persisted host, rebuild origins, re-broadcast; `:478-482` the **CATASTROPHIC** branch where
  the rollback bind also fails and the server ends with **no listener**.
- `server/ws-handler.ts:3943-3964` — `prepareForRebind()` (close all sockets with 4009,
  preserve the WSS).

### The one deliberate deviation: make the rebind actually transactional

NET-02 requires "update persistence only after the new listener is proven". **The reference
does the opposite**: `network-manager.ts:417` persists via `patchSettings` *before* the
rebind is even scheduled, and `rebind()` (`:449`) closes the old listener *before* attempting
the new bind — leaving a window where a squatter takes the port and both the new bind and the
rollback fail, which the code itself labels
`'CATASTROPHIC: Rollback bind also failed — server has no active listener'` (`:480`). That is
an objectively defective shape (self-asserted invariant violation + total loss of service),
so per user directive we **fix it in the port** and ledger the deviation rather than
replicating it.

**Verified experimentally (this session, on this kernel):**

| Experiment | Result |
|---|---|
| Bind `127.0.0.1:P`, then `0.0.0.0:P`, neither with `SO_REUSEPORT` | `EADDRINUSE` (98) |
| Both with `SO_REUSEPORT` | **both bind OK** |
| Loopback connection with both alive | delivered to the **more-specific `127.0.0.1` listener** |
| Non-`SO_REUSEPORT` squatter on `0.0.0.0:P`, then our `SO_REUSEPORT` bind | `EADDRINUSE` (98) — a foreign squatter still correctly blocks us |

So: **bind the new listener first (that IS the proof), then persist, then drain the old.**
Rollback becomes "drop the new socket" — a no-op that cannot fail. There is no window with
zero listeners, and no persisted state that outran reality.

Implementation: create the listener via `socket2` (already in `Cargo.lock:4350`, v0.6.4) with
`SO_REUSEPORT` + `SO_REUSEADDR` set on **both** the boot listener and every rebind listener,
then `TcpListener::from_std`. Serving moves from a single `axum::serve(listener, app)`
(`main.rs:1021`) to one `axum::serve(...).with_graceful_shutdown(...)` task **per listener**,
each with its own `Notify`; `BindState` holds the current host + the live listener task's
shutdown handle. Process shutdown triggers all of them.

**Documented trade-off (goes in the deviation entry):** `SO_REUSEPORT` lets another process
*of the same effective UID* bind the same port and steal a share of connections. On Linux the
same-EUID restriction means this is inside the same trust boundary as the auth token on a
single-user self-hosted box. Escape hatch: `FRESHELL_REBIND_NO_REUSEPORT=1` selects the
TS-faithful close-then-bind-with-rollback path (including its catastrophic branch), so the
old behavior remains reachable for anyone who wants it.

→ **Propose `DEV-00NN` in `port/oracle/DEVIATIONS.md`** (status: `proposed`; antagonist
adjudicates). objective_defect: *breaks an invariant the code itself asserts* +
loss-of-service, evidence `server/network-manager.ts:474-484`. pinning_test: the
squatter test in §Acceptance 4.

**WS handling during rebind.** The Rust WS layer has no `prepareForRebind`; it has a
per-connection shutdown arm (`freshell-ws/src/terminal.rs:234-241`, close 4009 "Server
shutting down") driven by `WsState.shutdown` (`lib.rs:175`). Because the new listener is up
*before* the old drains, existing sockets on the old listener can be left to drain
naturally rather than force-closed — strictly better UX than the reference's mass 4009. If
a socket must be dropped (old listener's graceful-shutdown deadline), it gets the same 4009
the client already handles. **Do not** reuse the process-wide `shutdown` `Notify` for this
(it would kill terminals) — the per-listener `Notify` is separate.

### `POST /api/network/configure` — behavior

1. Auth (`is_authed`) → 401 else.
2. Parse body; on failure 400 `{error:'Invalid request', details:[…]}` (zod-shaped issues).
   `host` accepts **only** the two literals — this is the NET-08 arbitrary-host defense and
   it is *structural*: the value that reaches the socket layer is an enum, so no attacker
   string can ever reach a bind call or a command runner.
3. Compute `host_changed` from the **live** bind (`BindState`), forced `false` on wsl2
   (`network-manager.ts:413`).
4. If changed: **bind the new listener and prove it** (start serving on it). On bind failure
   → 500, **nothing persisted, old listener untouched** (NET-02's "occupy the target address
   to force failure" case).
5. Persist `{network:{host, configured}}` through `SettingsStore` — the same serialized store,
   same `ConfigLock` flock + atomic tmp+rename + adopt-from-disk merge
   (`settings_store.rs:406-450`). **NET-09 rides this store; no new writer.**
6. Invalidate the facts cache; update `BindState`; drain the old listener.
7. Respond `{...status, rebindScheduled}` — note the reference computes `getStatus()` *after*
   `configure()` (`network-router.ts:438`) and the client tolerates a desired-state answer
   (`src/store/networkSlice.ts:47-54,58-91` polls `rebinding` up to 10×1s). Because our
   rebind is synchronous-and-proven, we can answer with the **settled truth** and
   `rebindScheduled: false`; the client's polling loop is a no-op in that case. Set
   `rebindScheduled: true` only if we ever defer. (Client contract check:
   `networkSlice.ts:118-124` sets `rebinding:true` locally when `rebindScheduled` — answering
   `false` with a settled status is the strictly better client experience and is contract-legal.)
8. Broadcast `{"type":"settings.updated","settings":<full tree>}` on `broadcast_tx` after
   responding (`network-router.ts:445`, mechanism identical to
   `settings_store.rs:1630-1632`).

### `POST /api/network/disable-remote-access` — behavior

Body schema is `ConfigureFirewallRequestSchema` (`network-router.ts:23-26`) —
`{confirmElevation?: true, confirmationToken?: string}`, **`.strict()`** (unknown keys → 400).

On this Linux/WSL2 host the resolution ladder (`network-router.ts:322-378`) lands as follows:
- `firewall.platform === 'wsl2'` → `computeWslPortForwardingTeardownPlanAsync`. Its inputs
  come from read-only `netsh … show` queries; if the plan is `Ready` the reference would
  return a **confirmable** action requiring elevated PowerShell → **HOST-BLOCKED**, we return
  the confirmation response (data only) and **never** elevate. If `noop`/`disabled`/`not-wsl2`
  → `{method:'none', message:'Remote access disabled'|'Remote access is not enabled'}` and,
  on the success message, `applyRemoteAccessDisabledState` (`:119-132`) runs — which is the
  **live Linux path we do implement**: rebind to `127.0.0.1` + persist + broadcast.
- `platform === 'linux-*' / 'macos'` (native Linux, the NET-10 lane) → `{method:'none'}` plus
  the same rebind-to-loopback.

**Verified teardown (NET-06)** means: after the response, the loopback listener is up (tier a
still 200) *and* the 0.0.0.0 listener is gone (tier b + tier c REFUSED). Do not claim
completion before the old listener is actually drained — the response is emitted after the
drain, not before. Only Freshell-managed state is touched: our own socket and our own
`settings.network` key. **No portproxy or firewall rule is read-modified, and none is ever
deleted** — that whole branch is Slice 3's fake-backed machinery.

`FRESHELL_DISABLE_WSL_PORT_FORWARD=1` (`port_forward.rs:254`, `wsl-port-forward.ts:371-375`)
is the harness's supported way to force the WSL2 teardown plan to `disabled` so the live
Linux path runs deterministically without any netsh query at all.

### Acceptance criteria

1. `configure {host:'0.0.0.0',configured:true}` → 200; status shows `host:'0.0.0.0'`,
   `portOpen:true`; **tier (b) 200**; **tier (c) 200** (or documented degradation).
2. `disable-remote-access {}` → 200 `{method:'none',…}`; status shows `host:'127.0.0.1'`,
   `portOpen:null`; **tier (b) REFUSED**; **tier (c) REFUSED** (or documented degradation);
   **tier (a) still 200**.
3. Round-trip is idempotent and repeatable ×3 with no port leak (`ss -ltn` shows exactly one
   listener on the port at every settled point).
4. **Squatter test (NET-02's explicit case):** occupy the target address with a foreign
   non-`SO_REUSEPORT` listener, `configure` → 500, **old listener still serving**, config
   **unchanged on disk**, then free the port and retry → succeeds.
5. **NET-09 byte-preservation:** seed `config.json` with sentinels in `sessionOverrides`,
   `terminalOverrides`, `projectColors`, `recentDirectories`, `serverSecrets`,
   `completedMigrations` (the real key set on this host); toggle remote access; restart;
   assert `network` changed as chosen and **every other top-level key is byte-identical**.
6. `settings.updated` is broadcast after each successful mutation, carrying the full tree.
7. Every mutation 401s without auth and 400s on a malformed body, with **zero** listener/config
   change (assert both).
8. Crash-safety: kill -9 mid-configure never leaves a state with no listener on restart
   (config either old or new, both bindable).

### NET evidence

- **NET-02** (transactional configure/rebind) — primary, *exceeding* the reference.
- **NET-06** (safe disable, verified teardown, loopback preserved) — primary for the Linux lane;
  the Windows/WSL2 managed-rule teardown remains HOST-BLOCKED (Slice 3).
- **NET-09** (lossless writes through the serialized store) — primary.
- **NET-01/03** (status + share URL stay truthful across the transition).
- **NET-08** (auth + validation + arbitrary-host rejection on both mutations).

---

## Slice 3 — Firewall endpoint + Windows machinery behind fakes

**Theme:** `POST /api/network/configure-firewall` with the complete confirmation-token
protocol, plus WSL2 portproxy planning — with **every** OS mutation behind the injected
`CommandRunner`, and the real-runner path for Windows mutation **structurally unreachable on
this host**.

### Files to touch

| File | Change |
|---|---|
| `crates/freshell-server/src/network.rs` | The `configure-firewall` route; wire `ConfirmationGate`; the shared action-resolution ladder used by both this and `disable-remote-access` |
| `crates/freshell-platform/src/elevated.rs` | Extend `ConfirmationGate` (`:137-266`) with the reference's *fresh re-check under the lock* and the denial/timeout/partial outcomes |
| `crates/freshell-platform/src/port_forward.rs` | Runner-backed plan assembly (read-only `show` queries) — builders already exist (`:413`, `:473`) |
| `crates/freshell-platform/src/firewall.rs` | Managed-port staleness read (`get_existing_managed_windows_firewall_ports`, `:313`) feeding `stale` |
| `crates/freshell-server/src/settings_store.rs` or a new small module | Managed-Windows-ports persistence (`network-manager.ts:110-135`), fake-backed |

### TS reference anchors

- `server/network-router.ts:617-758` — the route.
- Confirmation machinery: `issueConfirmation` `:218-228`; `matchesConfirmation` `:230-235`;
  `consumeConfirmation` `:237-244`; `consumeCurrentConfirmation` `:95-103`;
  `acquireConfirmedRepairLock` `:246-262`; `confirmedRepairInFlight` pre-checks `:624-629`
  **and** `:653-658` (checked twice — before and after action resolution, because resolution
  awaits); the **fresh re-check under the lock** `:672-700` (re-reads status+settings and
  re-resolves the action, so a token confirmed against stale facts cannot execute a stale script).
- `startElevatedRepair` `:150-216` — spawn, `setFirewallConfiguring(true)`, the
  `verifySuccess` → `onSuccess` → `settleRepair` chain, and the `child.on('error')` path.
- `resolveRepairAction` `:264-320`; verifiers `:380-410`.
- `ConfigureFirewallRequestSchema` `:23-26` (`.strict()`).
- Client contract: `src/lib/firewall-configure.ts:3-14` (the exact `ConfigureFirewallResult`
  union) and `:41-48` (409 + `method:'in-progress'` is caught and normalized, so the 409 body
  **must** carry `method:'in-progress'`); `NetworkSettings.tsx:236-267` (result dispatch),
  `:355-370` (confirm → re-POST with `{confirmElevation:true, confirmationToken}`).

### Behavior on this host

Resolution (`resolveRepairAction`) on WSL2 with remote access requested and `portOpen !== true`
returns a **confirmable** `wsl2-repair`. Our route:
1. Auth → 401; strict-parse → 400.
2. `repair_in_flight` → 409 `{error:'Firewall configuration already in progress', method:'in-progress'}`.
3. No/mismatched token → 200 `{method:'confirmation-required', title, body, confirmLabel,
   confirmationToken}` — a fresh UUID bound to the action. **No OS call.**
4. Matching token → acquire lock (lose the race → 409) → **re-resolve against fresh facts** →
   consume the token (single-use) → dispatch the script through the injected runner.
5. On this Linux host the injected runner for the Windows/elevated path is **not** the real
   `StdCommandRunner`. Structural unreachability (see below).
6. `none`/`terminal` outcomes return their reference bodies; `terminal` (native Linux `ufw`)
   returns the guidance command string and the client opens a terminal tab
   (`NetworkSettings.tsx:250-258`) — **the server never runs it** (NET-10).

**Structural unreachability of the real Windows mutation path.** Not a runtime `if`, a type:
the elevation dispatcher is constructed with an `ElevationRunner` enum whose real variant is
built **only** under `#[cfg(windows)]`; on non-Windows the constructor can only produce
`ElevationRunner::Unsupported`, which returns a `not-supported` outcome without touching a
process. A compile-time test (`#[cfg(not(windows))]`) asserts the real variant cannot be
constructed, and a runtime test asserts `FakeCommandRunner::call_count() == 0` for every
path this Linux host can reach. This is stronger than "we promise not to call it" and satisfies
`port/HANDOFF.md:192-195` by construction.

**NET-07 semantics behind fakes.** Model the four outcomes as explicit variants driven by
scripted `FakeCommandRunner` responses, each with a golden test:
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

**NET-05 (WSL2 portproxy planning).** The plan builders already exist
(`port_forward.rs:413`, `:473`) with the script normalizer (`:264`). Slice 3 wires the
**read-only** inputs — `get_wsl_ip` (`:549`, `ip -4 addr show eth0` / `hostname -I`),
`get_existing_port_proxy_rules` (`:565`), `get_existing_firewall_ports` (`:578`) — and asserts
the produced script byte-for-byte against goldens. The script is **returned/logged, never
executed**. A golden test pins the plan produced from *this host's real, captured*
`netsh interface portproxy show all` output (13 rules incl. the tier-c
`0.0.0.0:3001 -> 172.30.149.249:3001`) — proving the planner correctly recognizes the
pre-existing 3001 rule as already-satisfying and would emit **no** add for it.

**NET-04 managed rules + staleness.** `managed_windows_firewall_rule_name` (`firewall.rs:230`)
= `Freshell (port N)`; add/delete/repair builders `:248/:261/:278`. Wire the `stale` parameter
that Slice 1 turned into an input, driven by `get_existing_managed_windows_firewall_ports`
(`:313`) over a fake. Golden test: an unrelated sentinel rule name is **never** in any delete
command (the checklist's "unrelated sentinel rule survives").

### Acceptance criteria

1. First POST (no token) → 200 `confirmation-required` with a fresh UUID; `FakeCommandRunner`
   call count **0**.
2. Second POST with that token → the action proceeds through the **fake**; response is
   `{method:'wsl2'|'windows-elevated', status:'started'}`.
3. **Replay:** re-POST the same token → a *new* `confirmation-required` (token was consumed),
   never a second execution.
4. **Wrong-action token:** a token issued for `wsl2-repair` presented to
   `disable-remote-access` (`wsl2-disable`) → re-issue, never execute (`matchesConfirmation`
   is action-bound, `:230-235`).
5. **Concurrency:** two confirmed requests in flight → exactly one proceeds, the other gets
   409 with `method:'in-progress'`; the lock is released exactly once.
6. **Stale-facts race:** facts change between issue and confirm → the under-lock re-resolution
   produces a different action → re-issue, never execute the stale script.
7. NET-07 matrix (denial/timeout/partial/verification-failure): each leaves
   `firewall.configuring === false`, no false persisted success, and a subsequent success
   after switching the fake to a good response.
8. Golden strings byte-exact for: elevated arg wrapping (`elevated.rs:24`), Windows add/delete/
   repair, WSL2 full + firewall-only + teardown scripts.
9. **Zero real OS mutation**: aggregate assertion across the whole slice's test suite that no
   `netsh … add|delete|set`, no `Start-Process -Verb RunAs`, and no `ufw`/`iptables` ever
   reached a real runner; plus the compile-time unreachability test.

### NET evidence

- **NET-04** — implemented + golden-tested; **live effects HOST-BLOCKED (deferred-with-evidence)**.
- **NET-05** — planner implemented + golden-tested against real captured host output; **live effects HOST-BLOCKED**.
- **NET-07** — all four failure modes implemented + tested behind fakes; **live elevation HOST-BLOCKED**.
- **NET-08** — token single-use, action-bound, replay-rejected, overlapping-op 409 — primary.
- **NET-10** — the `terminal`/`ufw` guidance branch returns data and never executes.

> **HOST-BLOCKED declaration.** NET-04, NET-05, and NET-07 require a disposable **elevated
> Windows VM** (`PW-TAURI-WIN` + `HARNESS-09`), which this host is not and which
> `port/HANDOFF.md:192-195` forbids simulating by executing real mutations. They are marked
> **deferred-with-evidence**: implementation complete, golden/fake-backed tests green, live
> effect unexecuted **by design**. Matches their **H** classification in
> `docs/plans/2026-07-18-checklist-reconciliation.md:258-262`. Do **not** check these boxes;
> record the evidence and the block.

---

## Harness spec — `scripts/verify-remote-access.sh`

One self-contained bash script. Boots the built Rust server with an isolated `HOME`, exercises
all five endpoints (auth positive + negative), proves expose/retract on the three-tier vantage
ladder, runs the NET-08 negative matrix, reaps everything it started, and **exits 0 only if
every check passes**.

### Invocation & options

```
scripts/verify-remote-access.sh [--port N] [--keep-home] [--no-tier-c] [--verbose]
```
Default port **3001** (the only port where tier (c) is valid). Any other port ⇒ tier (c)
auto-degrades with a note. Writes a machine-readable summary to
`/tmp/freshell-verify-remote-access-<pid>/report.json` plus a human summary on stdout.

### Phase 0 — preflight (fail fast, before starting anything)

1. `set -euo pipefail`; `trap cleanup EXIT INT TERM`.
2. Assert branch/dirty state is sane; assert `target/release/freshell-server` exists and is
   newer than the crate sources (else `cargo build --release -p freshell-server`).
3. **Refuse to touch the live server:** if `$PORT == 3002` → hard error. Assert the pid in
   `~/.freshell/rust-server-3002.pid` is not something we could kill.
4. `WSL_IP="$(ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+')"` — **re-resolved every run**,
   never read from `.verify-vantages.env`. Empty ⇒ tier (b) unavailable ⇒ **hard fail**
   (tier (b) is REQUIRED).
5. Tier (b) liveness: `powershell.exe -NoProfile -Command "echo ok"` must succeed.
6. **Tier (c) preconditions** (all read-only):
   - `ss -ltn | grep ':3001 '` → must be empty (no legacy TS server holding it);
   - `powershell.exe -NoProfile -Command "netsh interface portproxy show all"` must contain a
     rule `0.0.0.0 3001 -> <WSL_IP> 3001`. If the connect-address ≠ current `WSL_IP`,
     **DEGRADE tier (c)** with the note `portproxy target <old> != current eth0 <new>`;
   - `ssh -o BatchMode=yes -o ConnectTimeout=8 shapiroserver2 true` must succeed, else degrade.
   - This is the **only** permitted `netsh` use, and it is read-only.
7. Isolated home: `HOME_DIR=$(mktemp -d)`; seed
   `$HOME_DIR/.freshell/config.json` with the full sentinel set (`version`, `settings`,
   `sessionOverrides`, `terminalOverrides`, `projectColors`, `recentDirectories`,
   `serverSecrets`, `completedMigrations`) and record its sha256 per top-level key.
8. `AUTH_TOKEN=$(openssl rand -hex 32)`; never echoed, never written to the report.

### Phase 1 — boot

Start with `HOME=$HOME_DIR FRESHELL_HOME=$HOME_DIR AUTH_TOKEN=… PORT=$PORT
FRESHELL_DISABLE_WSL_PORT_FORWARD=1 target/release/freshell-server`, log to the temp dir, pid
to `$TMP/server.pid`. Wait for `/api/health` (unauthenticated) up to 20s. Record the pid's
`/proc/<pid>/cwd` + cmdline so cleanup can **ownership-verify** before killing (never a broad
pattern kill — `AGENTS.md` Process Safety).

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

Shape check on status asserts **every** key of `NetworkStatus`
(`server/network-manager.ts:189-209`) is present with the right JSON type, and that the
content-type is `application/json; charset=utf-8`.

### Phase 3 — expose sequence

1. `POST /api/network/configure {"host":"0.0.0.0","configured":true}` → 200.
2. `GET /api/network/status` → `host == "0.0.0.0"`, `firewall.portOpen == true`,
   `remoteAccessEnabled == true`.
3. **Tier (a)** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/` → `200`.
4. **Tier (b)** `powershell.exe -NoProfile -Command "…Invoke-WebRequest -UseBasicParsing
   -TimeoutSec 5 http://$WSL_IP:$PORT/…"` → `STATUS 200`. **REQUIRED.**
5. **Tier (c)** `ssh shapiroserver2 "curl -s -o /dev/null -w '%{http_code}' --max-time 6
   http://192.168.3.50:3001/"` → `200`, or record a degradation note and continue.

### Phase 4 — retract sequence

1. `POST /api/network/disable-remote-access {}` → 200, body has `method`.
2. `GET /api/network/status` → `host == "127.0.0.1"`, `portOpen == null`,
   `remoteAccessEnabled == false`.
3. **Tier (b)** → **REFUSED** (`Unable to connect` / non-200). Required.
4. **Tier (c)** → **REFUSED** (`000`), or documented degradation.
5. **Tier (a)** → still `200` (loopback survives — the NET-06 core claim).
6. `ss -ltn | grep ":$PORT "` → exactly one listener, bound `127.0.0.1`.

### Phase 5 — restart / NET-09 byte preservation

1. SIGTERM the owned pid; wait for exit (bounded, then verify, never blind SIGKILL).
2. Diff `config.json`: `settings.network` reflects the chosen state; **every other top-level
   key byte-identical** to the Phase-0 sentinels (sha256 per key).
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

Cases 5/6/14 are additionally proved *structurally* by the Rust unit tests (`host` is an enum;
`FakeCommandRunner::call_count() == 0`) — the harness proves the black-box contract, the unit
tests prove nothing reached a runner. Both are required; neither substitutes for the other.

Also scan the server log for the auth token (NET-03: the secret must never be logged) → must
be absent.

### Phase 7 — cleanup & exit

1. Kill only the recorded pid, **after** verifying `/proc/<pid>/cwd` + cmdline match this
   repo's `freshell-server` (never a pattern kill).
2. Assert no listener remains on `$PORT` (`ss -ltn`).
3. Remove the temp home unless `--keep-home`.
4. Assert we created/modified **zero** portproxy or firewall rules: re-run the read-only
   `netsh interface portproxy show all` and diff against the Phase-0 capture — **must be
   identical**. This is the harness's own proof that it respected safety rule 6.
5. Exit `0` only if all required checks passed. Tier-(c) degradation is **not** a failure but
   **must** appear in the report as a `degraded` entry with its reason. Tier-(b) failure **is**
   a failure.

### Report

`report.json`: `{ port, wsl_ip, tiers: {a,b,c: {status, detail}}, phases: [...],
net_items_evidenced: [...], degradations: [...], deferred_host_blocked: ["NET-04","NET-05","NET-07"],
passed: bool }`.

---

## Cross-cutting: deviations to adjudicate

Record in `port/oracle/DEVIATIONS.md` (status `proposed`; the antagonist reviewer adjudicates,
never the implementer — `DEVIATIONS.md:8`):

1. **Transactional rebind (bind-new-before-persist, `SO_REUSEPORT`).** objective_defect:
   *breaks an invariant the code itself asserts* + loss of service —
   `server/network-manager.ts:474-484` (`'CATASTROPHIC: Rollback bind also failed — server has
   no active listener'`) and persistence-before-proof at `:417` vs NET-02's explicit
   requirement. port_behavior: prove the new listener first, then persist, then drain; rollback
   is an infallible socket drop. Escape hatch `FRESHELL_REBIND_NO_REUSEPORT=1`.
   fingerprint: `rebindScheduled` false-with-settled-status on a successful host change.
   pinning_test: the squatter test (Slice 2 acceptance 4).
2. **Settled-status response to `configure`.** The reference answers with a desired-state
   preview and makes the client poll (`networkSlice.ts:58-91`). Ours answers with settled
   truth and `rebindScheduled:false`. Contract-legal (client treats it as a normal status) and
   strictly better. Low-risk, but ledger it so the differ doesn't flag it.
3. **No mass 4009 on rebind.** The reference force-closes every WS connection
   (`ws-handler.ts:3943-3964`) because it must close the listener first. With overlapping
   listeners we let old connections drain. Ledger as an intentional UX improvement.

Do **not** replicate: the reference's wsl2 `remoteAccessEnabled = rawPortOpen === true`
(ignoring `remoteAccessRequested`, `network-manager.ts:349-350`) looks odd but is the
**client contract** (`src/lib/share-utils.ts:17-21` and the WSL "reachability unknown" branch
`:24-34` depend on it). Keep it faithful; note it as *reviewed and deliberately kept*.

## Sequencing & definition of done

Slices are strictly ordered: Slice 1's live-state reshape is a hard prerequisite for Slice 2
(you cannot rebind against a frozen `effective_host`), and Slice 2's action ladder is reused by
Slice 3. Each slice is Red-Green-Refactor with unit + integration coverage before moving on
(`AGENTS.md` Development Philosophy).

**Done** = all three slices merged on the branch; `cargo test -p freshell-server -p
freshell-platform` green; `scripts/verify-remote-access.sh` exits 0 with tier (a)+(b) passing
(tier (c) passing or explicitly degraded-with-reason); the deviation entries filed as
`proposed`; NET-01/02/03/06/08/09/10 evidenced; NET-04/05/07 recorded as
**HOST-BLOCKED / deferred-with-evidence** and left unchecked.
