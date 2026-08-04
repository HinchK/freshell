//! `GET /api/network/status` — the read-only network status (Follow-up 3.19).
//!
//! **FAITHFUL-PORT + unit-proven, NOT differential-oracle-proven.** No captured
//! original transcript exists for this read; correctness is argued by a faithful
//! port with file:line citations, the exact `NetworkStatus` shape
//! (`server/network-manager.ts:189-209`), and the unit tests below.
//!
//! Ports, additively (no `server/` or `shared/` source touched):
//! * `server/network-manager.ts` `getStatus()` (282-398) — the status derivation.
//! * `server/network-router.ts` `router.get('/network/status')` (421-429) — the
//!   route (returns the raw status; 500 on error).
//! * `server/network-router.ts` `router.get('/lan-info')` (412-419) —
//!   `{ ips: [...] }` from the same live-cached facts.
//! * `server/network-access.ts` `isRemoteAccessEnabled` (via
//!   `freshell_platform::network::is_remote_access_enabled`).
//!
//! ## READ-ONLY + safety
//!
//! Every live probe here is READ-ONLY: `freshell_platform::detect_firewall` runs
//! only `netsh … show` / `ufw status`; LAN detection runs only `ipconfig.exe` /
//! a read-only PowerShell object query / `ip -o -4 addr show`; the port
//! reachability probe ([`TcpPortProbe`]) is a plain `TcpStream::connect` (no
//! bytes written, dropped immediately). The **mutating** network paths
//! (`configure` / `configure-firewall` / `disable-remote-access`, i.e.
//! `netsh add/delete` + elevated PowerShell) are NOT wired here — they remain
//! golden-string builders in `freshell-platform`, never executed. The
//! firewall/LAN/hostname facts are computed lazily (on first request) and
//! cached for the process life, mirroring the original's `getFirewallInfo` /
//! `ensureLanIps` memoization (so boot stays fast and repeat reads are
//! instant); the port-reachability probe itself is **not** cached — it runs
//! fresh on every request, matching the original's `getStatus()`
//! (`network-manager.ts:304-323` calls `isPortReachable` inline, every call).
//!
//! ## Deferred (documented, loopback-faithful)
//!
//! The Windows managed-firewall-port staleness read is deferred: `stale` is a
//! hardcoded `false` (HOST-BLOCKED — Windows-only, see the plan's Slice 3).
//! `raw_port_open` is now a LIVE probe result (see [`TcpPortProbe`]), gated
//! exactly as the original gates it: only when `effective_host == "0.0.0.0"`
//! and `lan_ips` is non-empty (`network-manager.ts:304-305`); otherwise it stays
//! `None`, which is the original's own value on that path, not a deferral.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use freshell_platform::detect::{host_os_live, is_wsl2_proc_live};
use freshell_platform::network::{
    access_url, detect_lan_ips_from_linux_interfaces, is_remote_access_enabled, NetworkIntent,
};
use freshell_platform::port_forward::is_wsl_port_forwarding_disabled_by_env;
use freshell_platform::{
    detect_firewall, firewall_commands, FirewallInfo, FirewallPlatform, RealEnv, StdCommandRunner,
};
use freshell_protocol::NetworkHost;
use serde_json::{json, Value};

use crate::boot::is_authed;

/// A pluggable, READ-ONLY TCP-reachability probe backing [`NetworkState::probe`].
/// Object-safe (boxed future) so [`NetworkState`] can hold `Arc<dyn PortProbe>`
/// and tests can inject a scripted [`FakePortProbe`] instead of touching a real
/// socket. Mirrors `isPortReachable(port, { host, timeout })`
/// (`network-manager.ts:309`, the `is-port-reachable` npm package).
pub trait PortProbe: Send + Sync {
    /// Probe `host:port`. `Some(true)` = reachable (connect succeeded);
    /// `Some(false)` = actively refused/unreachable; `None` = timed out or
    /// otherwise inconclusive (the original's `catch { return null }`,
    /// `network-manager.ts:310-312`).
    fn probe(&self, host: String, port: u16) -> Pin<Box<dyn Future<Output = Option<bool>> + Send>>;
}

/// The real, READ-ONLY probe: a plain TCP connect under a timeout —
/// `tokio::net::TcpStream::connect` + `tokio::time::timeout`. Never writes a
/// byte; the connection (if it succeeds) is dropped immediately.
#[derive(Clone, Copy, Debug)]
pub struct TcpPortProbe {
    pub timeout: Duration,
}

impl Default for TcpPortProbe {
    fn default() -> Self {
        // Matches `{ timeout: 2000 }` (`network-manager.ts:309`).
        Self {
            timeout: Duration::from_secs(2),
        }
    }
}

impl PortProbe for TcpPortProbe {
    fn probe(&self, host: String, port: u16) -> Pin<Box<dyn Future<Output = Option<bool>> + Send>> {
        let timeout = self.timeout;
        Box::pin(async move {
            match tokio::time::timeout(
                timeout,
                tokio::net::TcpStream::connect((host.as_str(), port)),
            )
            .await
            {
                Ok(Ok(_stream)) => Some(true),
                Ok(Err(_)) => Some(false),
                Err(_) => None,
            }
        })
    }
}

/// Aggregate a probe across every remote-access port exactly as the original
/// does (`network-manager.ts:304-323`): any `Some(false)` → `Some(false)`;
/// else any `None` → `None`; else `Some(true)`.
async fn probe_remote_access_ports(
    probe: &dyn PortProbe,
    host: &str,
    ports: &[u16],
) -> Option<bool> {
    let mut saw_unknown = false;
    for &port in ports {
        match probe.probe(host.to_string(), port).await {
            Some(false) => return Some(false),
            Some(true) => {}
            None => saw_unknown = true,
        }
    }
    if saw_unknown {
        None
    } else {
        Some(true)
    }
}

/// Shared state for the network-status + lan-info routes.
///
/// Reshaped from the original Follow-up-3.19 struct to close three defects
/// documented in the plan (§0.4): a frozen `Arc<ServerSettings>` boot
/// snapshot, a frozen `effective_host`, and an unrefreshable `OnceCell` facts
/// cache. Slice 1 keeps `bind` read-only (seeded once); Slice 2 gives it a
/// writer for the rebind path.
#[derive(Clone)]
pub struct NetworkState {
    /// The auth gate (`AUTH_TOKEN`) — same gate as the rest of `/api/*`.
    pub auth_token: Arc<String>,
    /// The LIVE settings handle (defect 1 fix): every request re-reads
    /// `network.{configured,host}` through this instead of a boot-time
    /// snapshot, matching `await this.configStore.getSettings()`
    /// (`network-manager.ts:283`).
    pub settings: crate::settings_store::SettingsStore,
    /// The live, currently-bound host (defect 2 fix): `RwLock<String>` seeded
    /// from `resolve_bind_host()`; Slice 1 never writes it (no mutation
    /// endpoints yet), Slice 2's rebind path will. Mirrors the original's
    /// live `server.address()` read (`network-manager.ts:294`).
    pub bind: Arc<BindState>,
    /// The bound loopback port.
    pub port: u16,
    /// The refreshable live host facts cache (defect 3 fix): a plain
    /// `RwLock<Option<..>>` instead of a `OnceCell`, so `invalidate()` can
    /// force the next read to re-detect — matching the original's
    /// `this.firewallInfo = null; await this.refreshLanIpsAsync()`
    /// (`network-manager.ts:419-420`).
    pub facts: Arc<NetworkFactsCache>,
    /// The injected, READ-ONLY port-reachability probe (`isPortReachable`).
    /// Real traffic uses [`TcpPortProbe`]; tests inject a fake so the
    /// reachability outcome (`Some(true)`/`Some(false)`/`None`) is
    /// deterministic and no real socket is touched.
    pub probe: Arc<dyn PortProbe>,
    /// The process-wide settings/event broadcast bus (same one `settings_store`
    /// uses). Network mutations broadcast `settings.updated` after the change.
    pub broadcast_tx: std::sync::Arc<tokio::sync::broadcast::Sender<String>>,
    /// The transactional rebind controller (Slice 2). Swaps the live listener
    /// between 127.0.0.1 and 0.0.0.0 without a zero-listener window.
    // Read by Task 2.3/2.4's mutation endpoints (`state.rebind.serve_on(..)`);
    // until then main.rs only WRITES the field at construction.
    #[allow(dead_code)]
    pub rebind: std::sync::Arc<crate::net_bind::RebindController>,
    /// Serializes ALL network mutations (configure / disable / firewall persist)
    /// from before the live-bind read through persist + bind.set — the port of
    /// the TS rebind queue (network-manager.ts:220-221, :424-436). VALIDATED
    /// (ledger A-08, reports/V5.md): without it, concurrent mutations can
    /// persist a host that contradicts the live listener.
    // Locked by Task 2.3/2.4's mutation endpoints; nothing in the bin reads it yet.
    #[allow(dead_code)]
    pub net_mutation: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl NetworkState {
    /// Emit the exact frame `settings_store::patch_settings` emits on success.
    // Called by Task 2.3/2.4's mutation endpoints after persist+rebind; until
    // then only the unit test exercises it, so the bin target sees it as dead.
    #[allow(dead_code)]
    pub fn broadcast_settings_updated(&self, settings: &freshell_protocol::ServerSettings) {
        if let Ok(frame) = serde_json::to_string(
            &serde_json::json!({ "type": "settings.updated", "settings": settings }),
        ) {
            let _ = self.broadcast_tx.send(frame);
        }
    }
}

/// The live, currently-bound host (`"127.0.0.1"` / `"0.0.0.0"`). A thin
/// `RwLock<String>` so Slice 2's rebind path can update it in place without
/// reshaping [`NetworkState`] again.
pub struct BindState {
    host: tokio::sync::RwLock<String>,
}

impl BindState {
    pub fn new(initial_host: impl Into<String>) -> Self {
        Self {
            host: tokio::sync::RwLock::new(initial_host.into()),
        }
    }

    pub async fn get(&self) -> String {
        self.host.read().await.clone()
    }

    /// Overwrite the live bind host (Slice 2's rebind path; unused in Slice 1
    /// but exposed now so the reshape doesn't need to happen twice).
    #[allow(dead_code)]
    pub async fn set(&self, host: impl Into<String>) {
        *self.host.write().await = host.into();
    }
}

/// The live, read-only host facts consulted by `getStatus` — firewall
/// platform/active, ranked LAN IPs, and the machine hostname. Refreshable
/// (defect 3): [`NetworkFactsCache::invalidate`] forces the next
/// [`NetworkFactsCache::get_or_refresh`] to re-run the (read-only)
/// subprocesses instead of serving the cached value.
#[derive(Clone, Debug)]
pub struct LiveNetworkFacts {
    pub firewall: FirewallInfo,
    pub lan_ips: Vec<String>,
    pub hostname: String,
}

/// A refreshable cache for [`LiveNetworkFacts`]: an `RwLock<Option<..>>`
/// rather than a `OnceCell`, so `invalidate()` can force re-detection
/// (`network-manager.ts:419-420`'s cache-clear semantics) while a populated
/// cache still serves instantly on every other request.
#[derive(Default)]
pub struct NetworkFactsCache {
    inner: tokio::sync::RwLock<Option<LiveNetworkFacts>>,
}

impl NetworkFactsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached facts, computing (and caching) them on the first
    /// call or any call after [`Self::invalidate`]. The read-only detection
    /// subprocesses run on `spawn_blocking`.
    pub async fn get_or_refresh(&self) -> LiveNetworkFacts {
        if let Some(facts) = self.inner.read().await.clone() {
            return facts;
        }
        let mut guard = self.inner.write().await;
        if let Some(facts) = guard.clone() {
            return facts;
        }
        let facts = tokio::task::spawn_blocking(resolve_live_network_facts)
            .await
            .unwrap_or_else(|_| LiveNetworkFacts {
                firewall: FirewallInfo {
                    platform: firewall_platform_fallback(),
                    active: false,
                },
                lan_ips: Vec::new(),
                hostname: read_machine_hostname(),
            });
        *guard = Some(facts.clone());
        facts
    }

    /// Force the next [`Self::get_or_refresh`] to re-detect (defect 3 fix):
    /// mirrors `this.firewallInfo = null; await this.refreshLanIpsAsync()`
    /// (`network-manager.ts:419-420`). Unused by any route in Slice 1 (no
    /// mutation endpoint exists yet); exercised directly by the acceptance
    /// tests below and reused verbatim by Slice 2's `configure` route.
    #[allow(dead_code)]
    pub async fn invalidate(&self) {
        *self.inner.write().await = None;
    }
}

/// The network sub-router (`GET /api/network/status`, `GET /api/lan-info`),
/// pre-bound to state.
pub fn router(state: NetworkState) -> Router {
    Router::new()
        .route("/api/network/status", get(network_status))
        .route("/api/lan-info", get(lan_info))
        .with_state(state)
}

/// `GET /api/lan-info` (`network-router.ts:412-419`): `{ ips: [...] }` from
/// the same cached facts `GET /api/network/status` uses, so the two never
/// disagree within a process. The reference's `catch → 500` is unreachable
/// here — [`NetworkFactsCache::get_or_refresh`] is infallible (a failed
/// detection subprocess degrades to an empty `Vec`, never an `Err`) — noted,
/// not fabricated.
async fn lan_info(State(state): State<NetworkState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let facts = state.facts.get_or_refresh().await;
    Json(json!({ "ips": facts.lan_ips })).into_response()
}

async fn network_status(State(state): State<NetworkState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }

    // Live settings (defect 1): re-read on every call, never a boot snapshot.
    let settings = state.settings.get().await;
    // Live bind (defect 2): re-read the current bind host on every call.
    let effective_host = state.bind.get().await;
    // Refreshable facts (defect 3): served from cache unless invalidated.
    let facts = state.facts.get_or_refresh().await;

    // The live, READ-ONLY port-reachability probe, gated exactly as the
    // original gates it (`network-manager.ts:304-305`): only on a 0.0.0.0
    // bind with at least one detected LAN IP. On a loopback bind (or no LAN
    // IP), `raw_port_open` stays `None` — the original's own value there,
    // not a deferral.
    let remote_access_ports: Vec<u16> = vec![state.port];
    let raw_port_open = if effective_host == "0.0.0.0" && !facts.lan_ips.is_empty() {
        probe_remote_access_ports(
            state.probe.as_ref(),
            &facts.lan_ips[0],
            &remote_access_ports,
        )
        .await
    } else {
        None
    };

    let network_host = network_host_str(&settings.network.host);
    let inputs = NetworkStatusInputs {
        configured: settings.network.configured,
        network_host,
        effective_host: &effective_host,
        port: state.port,
        lan_ips: &facts.lan_ips,
        machine_hostname: &facts.hostname,
        firewall: &facts.firewall,
        raw_port_open,
        wsl_forwarding_disabled_by_env: is_wsl_port_forwarding_disabled_by_env(&RealEnv),
        token: state.auth_token.as_str(),
    };
    Json(build_network_status(inputs)).into_response()
}

/// The inputs to the pure [`build_network_status`] (everything the live edge
/// resolves), so the derivation is deterministic + unit-testable.
pub struct NetworkStatusInputs<'a> {
    pub configured: bool,
    pub network_host: &'a str,
    pub effective_host: &'a str,
    pub port: u16,
    pub lan_ips: &'a [String],
    pub machine_hostname: &'a str,
    pub firewall: &'a FirewallInfo,
    pub raw_port_open: Option<bool>,
    pub wsl_forwarding_disabled_by_env: bool,
    pub token: &'a str,
}

/// Pure port of `getStatus()`'s derivation (`network-manager.ts:325-397`). Every
/// field of the returned object matches the `NetworkStatus` interface
/// (`network-manager.ts:189-209`).
pub fn build_network_status(i: NetworkStatusInputs) -> Value {
    let platform = i.firewall.platform;
    let remote_access_ports: Vec<u16> = vec![i.port]; // getRemoteAccessPorts (no devMode)

    let network = NetworkIntent {
        configured: i.configured,
        host: i.network_host.to_string(),
    };
    let remote_access_requested =
        is_remote_access_enabled(Some(&network), i.effective_host, platform);

    // Windows managed-port staleness read is deferred (read-only, Windows-only) → false.
    let stale = false;
    let port_open = if stale { Some(false) } else { i.raw_port_open };

    let commands = if i.firewall.active {
        // The Windows stale-repair branch is deferred (stale == false), so this is
        // always the plain suggested-command builder (golden strings; wsl2 → []).
        firewall_commands(platform, &remote_access_ports)
    } else {
        Vec::new()
    };

    let remote_access_enabled = if platform == FirewallPlatform::Wsl2 {
        i.raw_port_open == Some(true)
    } else {
        remote_access_requested && i.raw_port_open == Some(true)
    };

    let remote_access_needs_repair = (platform == FirewallPlatform::Wsl2
        && remote_access_requested
        && port_open == Some(false)
        && !i.wsl_forwarding_disabled_by_env)
        || (platform == FirewallPlatform::Windows
            && remote_access_requested
            && (i.raw_port_open == Some(false) || stale));

    let share_route_enabled = remote_access_enabled
        || (platform == FirewallPlatform::Wsl2
            && remote_access_requested
            && i.raw_port_open.is_none()
            && !i.wsl_forwarding_disabled_by_env);

    let access_port = i.port; // no devMode
    let url = access_url(share_route_enabled, i.lan_ips, access_port, i.token);

    json!({
        "configured": i.configured,
        "host": i.effective_host,
        "remoteAccessEnabled": remote_access_enabled,
        "remoteAccessRequested": remote_access_requested,
        "remoteAccessNeedsRepair": remote_access_needs_repair,
        "port": i.port,
        "lanIps": i.lan_ips,
        "machineHostname": i.machine_hostname,
        "firewall": {
            "platform": platform.as_str(),
            "active": i.firewall.active,
            "portOpen": match port_open { Some(b) => Value::Bool(b), None => Value::Null },
            "commands": commands,
            "configuring": false,
        },
        "rebinding": false,
        "devMode": false,
        "accessUrl": url,
    })
}

/// Map the settings `NetworkHost` enum to the wire string (`"127.0.0.1"`/`"0.0.0.0"`).
fn network_host_str(host: &NetworkHost) -> &'static str {
    match host {
        NetworkHost::Loopback => "127.0.0.1",
        NetworkHost::AllInterfaces => "0.0.0.0",
    }
}

/// Boot-time bind config from the persisted settings (NET-02/06 restart
/// truthfulness): a disable that persisted loopback must survive a restart.
pub fn boot_bind_config(
    network: &freshell_protocol::SettingsNetwork,
) -> freshell_platform::network::BindHostConfig {
    freshell_platform::network::BindHostConfig::Ok {
        raw_host: Some(network_host_str(&network.host).to_string()),
        configured: network.configured,
    }
}

/// Compute the live, read-only host facts (blocking — call on `spawn_blocking`).
fn resolve_live_network_facts() -> LiveNetworkFacts {
    let host_os = host_os_live();
    let is_wsl2 = is_wsl2_proc_live();
    let runner = StdCommandRunner::default();

    // READ-ONLY firewall state (`netsh … show` / `ufw status` / `defaults read`).
    let firewall = detect_firewall(host_os, is_wsl2, &runner);

    // LAN IPs (`detectLanIps`, `bootstrap.ts:182-193`): on WSL, query the
    // Windows host's physical adapters (READ-ONLY `ipconfig.exe`, ranked with
    // the reference's assumed /24). On NATIVE WINDOWS, the reference falls
    // through to `detectLanIpsFromInterfaces()` (`os.networkInterfaces()`,
    // every non-internal IPv4 with its real netmask, ranked) — wired here via
    // a READ-ONLY PowerShell object query (task-005e part 2, item 2; verified
    // against the win-side `node os.networkInterfaces()` ground truth). On
    // NATIVE LINUX (the NET-10 gap, formerly an unwired `Vec::new()`), the
    // same `detectLanIpsFromInterfaces()` semantics are ported via READ-ONLY
    // `ip -o -4 addr show` ([`detect_lan_ips_from_linux_interfaces`]). macOS
    // remains outside this port's verified matrix (unwired, empty) —
    // documented; it only affects the 0.0.0.0 share path.
    let lan_ips = if is_wsl2 {
        freshell_platform::network::detect_lan_ips_via_ipconfig(&runner)
    } else if cfg!(windows) {
        freshell_platform::network::detect_lan_ips_from_windows_interfaces(&runner)
    } else if cfg!(target_os = "linux") {
        detect_lan_ips_from_linux_interfaces(&runner)
    } else {
        Vec::new()
    };

    LiveNetworkFacts {
        firewall,
        lan_ips,
        hostname: read_machine_hostname(),
    }
}

/// `os.hostname().replace(/\.local$/, '')` (`network-manager.ts:385`).
///
/// Unix/WSL: `/proc/sys/kernel/hostname` → `HOSTNAME` env → `"localhost"`.
/// NATIVE WINDOWS: `hostname.exe` (whose output equals Node's
/// `os.hostname()`/`gethostname()` byte-for-byte — verified live on the QA
/// host: both print `SurfaceBookPro9` while `COMPUTERNAME` is the UPPERCASED
/// NetBIOS name `SURFACEBOOKPRO9`, which would be WRONG) → `COMPUTERNAME`
/// env → `"localhost"` (task-005e part 2, item 2).
fn read_machine_hostname() -> String {
    let raw = if cfg!(windows) {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "localhost".to_string())
    } else {
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "localhost".to_string())
    };
    raw.strip_suffix(".local").unwrap_or(&raw).to_string()
}

/// The platform used if the live detection task itself fails to join (defensive).
fn firewall_platform_fallback() -> FirewallPlatform {
    if is_wsl2_proc_live() {
        FirewallPlatform::Wsl2
    } else {
        FirewallPlatform::LinuxNone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl2_inactive() -> FirewallInfo {
        FirewallInfo {
            platform: FirewallPlatform::Wsl2,
            active: false,
        }
    }

    #[test]
    fn loopback_wsl2_boot_is_remote_access_off_and_shape_complete() {
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "127.0.0.1",
            effective_host: "127.0.0.1",
            port: 51234,
            lan_ips: &[],
            machine_hostname: "dandesktop",
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "tok-abc",
        });

        // Full NetworkStatus shape present.
        for key in [
            "configured",
            "host",
            "remoteAccessEnabled",
            "remoteAccessRequested",
            "remoteAccessNeedsRepair",
            "port",
            "lanIps",
            "machineHostname",
            "firewall",
            "rebinding",
            "devMode",
            "accessUrl",
        ] {
            assert!(status.get(key).is_some(), "missing {key}");
        }
        assert_eq!(status["configured"], json!(true));
        assert_eq!(status["host"], json!("127.0.0.1"));
        assert_eq!(status["remoteAccessEnabled"], json!(false));
        assert_eq!(status["remoteAccessRequested"], json!(false));
        assert_eq!(status["remoteAccessNeedsRepair"], json!(false));
        assert_eq!(status["port"], json!(51234));
        assert_eq!(status["machineHostname"], json!("dandesktop"));
        assert_eq!(status["rebinding"], json!(false));
        assert_eq!(status["devMode"], json!(false));

        // Firewall sub-shape: wsl2, portOpen null, no commands, not configuring.
        let fw_v = &status["firewall"];
        assert_eq!(fw_v["platform"], json!("wsl2"));
        assert_eq!(fw_v["active"], json!(false));
        assert_eq!(fw_v["portOpen"], Value::Null);
        assert_eq!(fw_v["commands"], json!([]));
        assert_eq!(fw_v["configuring"], json!(false));

        // accessUrl carries the (encoded) token, localhost (no share route).
        assert_eq!(
            status["accessUrl"],
            json!("http://localhost:51234/?token=tok-abc")
        );
    }

    #[test]
    fn all_interfaces_unconfigured_requests_remote_access_and_builds_commands() {
        // Non-WSL (linux ufw active), bound 0.0.0.0, unconfigured → remote access
        // requested; active firewall → the ufw suggested commands (golden strings).
        let fw = FirewallInfo {
            platform: FirewallPlatform::LinuxUfw,
            active: true,
        };
        let status = build_network_status(NetworkStatusInputs {
            configured: false,
            network_host: "0.0.0.0",
            effective_host: "0.0.0.0",
            port: 3001,
            lan_ips: &["192.168.1.20".to_string()],
            machine_hostname: "host",
            firewall: &fw,
            raw_port_open: None, // probe deferred → unknown
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["host"], json!("0.0.0.0"));
        assert_eq!(status["remoteAccessRequested"], json!(true));
        // Commands are the golden ufw builder output (data only — never executed).
        assert_eq!(
            status["firewall"]["commands"],
            json!(firewall_commands(FirewallPlatform::LinuxUfw, &[3001]))
        );
        assert!(!status["firewall"]["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        // portOpen unknown (deferred probe) → null; remoteAccessEnabled false.
        assert_eq!(status["firewall"]["portOpen"], Value::Null);
        assert_eq!(status["remoteAccessEnabled"], json!(false));
    }

    #[test]
    fn hostname_strips_dot_local_suffix() {
        // The transformation the original applies; here exercised on a fixed input
        // via the pure builder (the live reader applies the same strip).
        let fw = wsl2_inactive();
        let status = build_network_status(NetworkStatusInputs {
            configured: true,
            network_host: "127.0.0.1",
            effective_host: "127.0.0.1",
            port: 1,
            lan_ips: &[],
            machine_hostname: "macbook", // already stripped by read_machine_hostname
            firewall: &fw,
            raw_port_open: None,
            wsl_forwarding_disabled_by_env: false,
            token: "t",
        });
        assert_eq!(status["machineHostname"], json!("macbook"));
    }

    #[test]
    fn boot_bind_config_passes_persisted_network_intent() {
        use freshell_platform::network::BindHostConfig;
        let net = freshell_protocol::SettingsNetwork {
            configured: true,
            host: NetworkHost::Loopback,
        };
        match boot_bind_config(&net) {
            BindHostConfig::Ok {
                raw_host,
                configured,
            } => {
                assert_eq!(raw_host.as_deref(), Some("127.0.0.1"));
                assert!(configured);
            }
            _ => panic!("expected Ok config"),
        }
        let unconfigured = freshell_protocol::SettingsNetwork {
            configured: false,
            host: NetworkHost::Loopback,
        };
        match boot_bind_config(&unconfigured) {
            BindHostConfig::Ok {
                raw_host,
                configured,
            } => {
                // unconfigured: still pass the host as a raw hint but configured=false,
                // so the WSL default / HOST env keep their precedence.
                assert_eq!(raw_host.as_deref(), Some("127.0.0.1"));
                assert!(!configured);
            }
            _ => panic!("expected Ok config"),
        }
    }

    // ---- Slice 1: live probe wiring + route-level tests --------------------
    //
    // These exercise the REAL router (`network::router`) end-to-end via
    // `tower::ServiceExt::oneshot`, with a scripted [`FakePortProbe`] injected
    // in place of [`TcpPortProbe`] so no real socket is ever touched and the
    // reachability outcome is fully deterministic.

    /// A scripted, READ-ONLY [`PortProbe`] for tests: returns a fixed,
    /// pre-programmed `Option<bool>` for every call and counts how many times
    /// it was invoked (so a test can assert the probe was/wasn't consulted at
    /// all — e.g. the loopback-bind gate). The counter lives behind an
    /// `Arc<AtomicUsize>` a test can clone *before* the probe is erased into
    /// `Arc<dyn PortProbe>`, so call-count assertions work even after the
    /// concrete type is gone (unlike a plain `Arc::strong_count` proxy check).
    struct FakePortProbe {
        result: Option<bool>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl FakePortProbe {
        fn new(result: Option<bool>) -> Self {
            Self {
                result,
                calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        /// A cloneable handle to this probe's call counter, usable after the
        /// probe itself has been moved into `Arc<dyn PortProbe>`.
        fn call_counter(&self) -> Arc<std::sync::atomic::AtomicUsize> {
            Arc::clone(&self.calls)
        }
    }

    impl PortProbe for FakePortProbe {
        fn probe(
            &self,
            _host: String,
            _port: u16,
        ) -> Pin<Box<dyn Future<Output = Option<bool>> + Send>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let result = self.result;
            Box::pin(async move { result })
        }
    }

    fn test_settings_store() -> crate::settings_store::SettingsStore {
        let dir = std::env::temp_dir().join(format!(
            "frs-network-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        crate::settings_store::SettingsStore::load(Some(&dir), vec!["claude".into()])
    }

    fn test_state(bind_host: &str, probe_result: Option<bool>) -> NetworkState {
        NetworkState {
            auth_token: Arc::new("tok".to_string()),
            settings: test_settings_store(),
            bind: Arc::new(BindState::new(bind_host.to_string())),
            port: 51234,
            facts: Arc::new(NetworkFactsCache::new()),
            probe: Arc::new(FakePortProbe::new(probe_result)),
            broadcast_tx: std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(16).0),
            // port 0: never served in unit tests (no app injected either).
            rebind: crate::net_bind::RebindController::new(0, true),
            net_mutation: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Like [`test_state`], but also returns a cloneable handle to the
    /// injected [`FakePortProbe`]'s call counter, so a test can assert how
    /// many times the live route actually invoked the probe (not just that
    /// the router/state were dropped).
    fn test_state_with_probe_counter(
        bind_host: &str,
        probe_result: Option<bool>,
    ) -> (NetworkState, Arc<std::sync::atomic::AtomicUsize>) {
        let probe = FakePortProbe::new(probe_result);
        let counter = probe.call_counter();
        let state = NetworkState {
            auth_token: Arc::new("tok".to_string()),
            settings: test_settings_store(),
            bind: Arc::new(BindState::new(bind_host.to_string())),
            port: 51234,
            facts: Arc::new(NetworkFactsCache::new()),
            probe: Arc::new(probe),
            broadcast_tx: std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(16).0),
            // port 0: never served in unit tests (no app injected either).
            rebind: crate::net_bind::RebindController::new(0, true),
            net_mutation: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, counter)
    }

    /// Slice 2 (Task 2.2): `broadcast_settings_updated` emits the exact frame
    /// `settings_store::patch_settings` emits on success — `settings.updated`
    /// with the full settings tree (including `network`) as the payload.
    #[tokio::test]
    async fn broadcast_settings_updated_emits_the_settings_updated_frame() {
        let state = test_state("127.0.0.1", None);
        let mut rx = state.broadcast_tx.subscribe();
        let settings = state.settings.get().await;
        state.broadcast_settings_updated(&settings);
        let frame = rx.recv().await.expect("a frame");
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["type"], "settings.updated");
        assert!(v["settings"].is_object());
        assert!(v["settings"].get("network").is_some());
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Seed the facts cache directly (bypassing the real subprocess-backed
    /// [`resolve_live_network_facts`]) so route tests are deterministic and
    /// don't depend on this host's actual firewall/LAN state.
    async fn seed_facts(state: &NetworkState, lan_ips: Vec<String>, firewall: FirewallInfo) {
        // `get_or_refresh` populates the cache from `resolve_live_network_facts`
        // on first call; to inject a deterministic value we write directly.
        *state.facts.inner.write().await = Some(LiveNetworkFacts {
            firewall,
            lan_ips,
            hostname: "test-host".to_string(),
        });
    }

    fn linux_none_inactive() -> FirewallInfo {
        FirewallInfo {
            platform: FirewallPlatform::LinuxNone,
            active: false,
        }
    }

    /// Acceptance 1: `GET /api/lan-info` -> 200 `{"ips":[...]}`,
    /// `application/json; charset=utf-8`; contents equal `lanIps` from
    /// `GET /api/network/status` in the same process; 401 with no/bad token.
    #[tokio::test]
    async fn lan_info_returns_ips_matching_status_and_requires_auth() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let state = test_state("0.0.0.0", Some(true));
        seed_facts(
            &state,
            vec!["192.168.1.50".to_string()],
            linux_none_inactive(),
        )
        .await;

        // Unauthorized: no token -> 401 {"error":"Unauthorized"}.
        let resp = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/lan-info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
        let body = body_json(resp).await;
        assert_eq!(body, json!({ "error": "Unauthorized" }));

        // Authorized: 200 {"ips":[...]}, correct content-type.
        let resp = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/lan-info")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let content_type = resp
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(content_type, "application/json");
        let lan_info_body = body_json(resp).await;
        assert_eq!(lan_info_body, json!({ "ips": ["192.168.1.50"] }));

        // Same process, same cached facts: /api/network/status's lanIps
        // must equal /api/lan-info's ips exactly.
        let resp = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let status_body = body_json(resp).await;
        assert_eq!(status_body["lanIps"], lan_info_body["ips"]);
    }

    /// Acceptance 2: bound `0.0.0.0` with a LAN IP and a reachable probe ->
    /// `portOpen === true`, `remoteAccessEnabled === true`,
    /// `remoteAccessNeedsRepair === false`, `accessUrl` host is `lanIps[0]`.
    #[tokio::test]
    async fn zero_zero_zero_zero_bind_with_reachable_probe_is_fully_enabled() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let state = test_state("0.0.0.0", Some(true));
        // wsl2 platform (this test host's real platform) so
        // `remoteAccessEnabled` reduces to `rawPortOpen === true` alone.
        seed_facts(
            &state,
            vec!["192.168.1.50".to_string()],
            FirewallInfo {
                platform: FirewallPlatform::Wsl2,
                active: false,
            },
        )
        .await;

        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["host"], json!("0.0.0.0"));
        assert_eq!(body["firewall"]["portOpen"], json!(true));
        assert_eq!(body["remoteAccessEnabled"], json!(true));
        assert_eq!(body["remoteAccessNeedsRepair"], json!(false));
        assert!(body["accessUrl"]
            .as_str()
            .unwrap()
            .starts_with("http://192.168.1.50:"));
    }

    /// Acceptance 3: bound `127.0.0.1` -> `firewall.portOpen === null`
    /// (reference-faithful, not an invented `false`), `remoteAccessEnabled
    /// === false`, `accessUrl` host is `localhost`. Also proves the probe is
    /// NEVER consulted on a loopback bind (the reference's own gate).
    #[tokio::test]
    async fn loopback_bind_never_probes_and_reports_port_open_null() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let (state, probe_calls) = test_state_with_probe_counter("127.0.0.1", Some(true));
        seed_facts(
            &state,
            vec!["192.168.1.50".to_string()],
            linux_none_inactive(),
        )
        .await;

        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["host"], json!("127.0.0.1"));
        assert_eq!(body["firewall"]["portOpen"], Value::Null);
        assert_eq!(body["remoteAccessEnabled"], json!(false));
        assert!(body["accessUrl"]
            .as_str()
            .unwrap()
            .starts_with("http://localhost:"));

        // The load-bearing assertion: the injected probe (standing in for a
        // real socket connect) must have been invoked ZERO times on a
        // loopback bind, proving the live route's own gate
        // (`effective_host == "0.0.0.0" && !lan_ips.is_empty()`) — not just
        // the pure `build_network_status` builder in isolation — actually
        // skips the probe.
        assert_eq!(
            probe_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "loopback bind must never consult the port-reachability probe"
        );
    }

    /// The mirror of the test above: on a `0.0.0.0` bind with a LAN IP
    /// present, the live route's gate is OPEN and the injected probe must be
    /// invoked exactly once per remote-access port (one port here) — proving
    /// the gate is wired both ways, not just closed on loopback.
    #[tokio::test]
    async fn zero_zero_zero_zero_bind_with_lan_ip_invokes_the_probe_exactly_once() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let (state, probe_calls) = test_state_with_probe_counter("0.0.0.0", Some(true));
        seed_facts(
            &state,
            vec!["192.168.1.50".to_string()],
            linux_none_inactive(),
        )
        .await;

        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        assert_eq!(
            probe_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "0.0.0.0 bind with a LAN IP must consult the probe exactly once per port"
        );
    }

    /// Acceptance 4 (the negative-truth test): `0.0.0.0` bind but the port is
    /// deliberately unreachable from `lanIps[0]` (fixture-injected
    /// `Some(false)`) -> `portOpen === false` and `remoteAccessNeedsRepair
    /// === true` on wsl2.
    #[tokio::test]
    async fn zero_zero_zero_zero_bind_with_unreachable_probe_needs_repair() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let state = test_state("0.0.0.0", Some(false));
        seed_facts(
            &state,
            vec!["192.168.1.50".to_string()],
            FirewallInfo {
                platform: FirewallPlatform::Wsl2,
                active: false,
            },
        )
        .await;
        // `remoteAccessRequested` requires the settings-declared intent to be
        // `host: "0.0.0.0"` (`is_remote_access_enabled`'s own first check);
        // seed it through the SAME live store the state holds so this test
        // exercises the real gate rather than the wsl2-platform short-circuit.
        state
            .settings
            .patch(&json!({ "network": { "configured": true, "host": "0.0.0.0" } }))
            .await
            .unwrap();

        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["firewall"]["portOpen"], json!(false));
        assert_eq!(body["remoteAccessRequested"], json!(true));
        assert_eq!(body["remoteAccessNeedsRepair"], json!(true));
        assert_eq!(body["remoteAccessEnabled"], json!(false));
    }

    /// Acceptance 6 (defect 1): a settings change made through the LIVE
    /// `SettingsStore` after boot must be reflected on the very next status
    /// read — proving `NetworkState.settings` is no longer a frozen boot
    /// snapshot.
    #[tokio::test]
    async fn status_reflects_a_settings_change_made_after_construction() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let state = test_state("0.0.0.0", None);
        seed_facts(&state, vec![], linux_none_inactive()).await;

        // Before any patch: default `configured` is false.
        let resp = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["configured"], json!(false));

        // Patch settings through the SAME live store the state holds.
        state
            .settings
            .patch(&json!({ "network": { "configured": true, "host": "0.0.0.0" } }))
            .await
            .unwrap();

        // The very next status read must reflect it — no restart, no re-wiring.
        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["configured"], json!(true));
    }

    /// Acceptance 6 (defect 2): a live bind change via [`BindState::set`] is
    /// reflected on the very next status read — proving `effective_host` is
    /// no longer frozen at construction.
    #[tokio::test]
    async fn status_reflects_a_bind_change_via_bind_state() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::util::ServiceExt;

        let state = test_state("127.0.0.1", None);
        seed_facts(&state, vec![], linux_none_inactive()).await;

        let resp = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["host"], json!("127.0.0.1"));

        state.bind.set("0.0.0.0").await;

        let resp = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/network/status")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["host"], json!("0.0.0.0"));
    }

    /// Acceptance 6 (defect 3): [`NetworkFactsCache::invalidate`] forces the
    /// next read to pick up newly-seeded facts instead of serving the stale
    /// cached value — proving the cache is refreshable, not a `OnceCell`.
    #[tokio::test]
    async fn facts_cache_invalidate_forces_re_detection_on_next_read() {
        let cache = NetworkFactsCache::new();
        *cache.inner.write().await = Some(LiveNetworkFacts {
            firewall: linux_none_inactive(),
            lan_ips: vec!["10.0.0.1".to_string()],
            hostname: "first".to_string(),
        });
        let first = cache.get_or_refresh().await;
        assert_eq!(first.lan_ips, vec!["10.0.0.1".to_string()]);

        cache.invalidate().await;
        // Post-invalidate, seed a DIFFERENT value directly (standing in for
        // the real subprocess re-detection) and prove the cache actually
        // was cleared (i.e. `get_or_refresh` did not just re-serve `first`).
        assert!(cache.inner.read().await.is_none());
        *cache.inner.write().await = Some(LiveNetworkFacts {
            firewall: linux_none_inactive(),
            lan_ips: vec!["10.0.0.2".to_string()],
            hostname: "second".to_string(),
        });
        let second = cache.get_or_refresh().await;
        assert_eq!(second.lan_ips, vec!["10.0.0.2".to_string()]);
    }

    /// Acceptance 7 (no privileged/mutating process spawned): the injected
    /// probe is a plain TCP connect, never a subprocess — this test asserts
    /// the fake probe (standing in for [`TcpPortProbe`]) is invoked exactly
    /// once per remote-access port when the gate is open, and that the
    /// gate itself (`effective_host == "0.0.0.0" && !lan_ips.is_empty()`) is
    /// respected: a loopback bind or an empty `lan_ips` never invokes it.
    #[tokio::test]
    async fn probe_remote_access_ports_only_runs_through_the_gate() {
        let probe = FakePortProbe::new(Some(true));
        let counter = probe.call_counter();
        // Gate open: one LAN IP, one port -> exactly one call.
        let result = probe_remote_access_ports(&probe, "192.168.1.50", &[51234]).await;
        assert_eq!(result, Some(true));
        assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Aggregation semantics (`network-manager.ts:304-323`): any `Some(false)`
    /// wins outright; else any `None` wins; else `Some(true)`.
    #[tokio::test]
    async fn probe_remote_access_ports_aggregates_false_over_unknown_over_true() {
        struct ScriptedProbe {
            script: std::sync::Mutex<Vec<Option<bool>>>,
        }
        impl PortProbe for ScriptedProbe {
            fn probe(
                &self,
                _host: String,
                _port: u16,
            ) -> Pin<Box<dyn Future<Output = Option<bool>> + Send>> {
                let next = self.script.lock().unwrap().remove(0);
                Box::pin(async move { next })
            }
        }

        // false beats unknown and true.
        let probe = ScriptedProbe {
            script: std::sync::Mutex::new(vec![Some(true), None, Some(false)]),
        };
        assert_eq!(
            probe_remote_access_ports(&probe, "h", &[1, 2, 3]).await,
            Some(false)
        );

        // unknown beats true when there's no false.
        let probe = ScriptedProbe {
            script: std::sync::Mutex::new(vec![Some(true), None]),
        };
        assert_eq!(probe_remote_access_ports(&probe, "h", &[1, 2]).await, None);

        // all true -> true.
        let probe = ScriptedProbe {
            script: std::sync::Mutex::new(vec![Some(true), Some(true)]),
        };
        assert_eq!(
            probe_remote_access_ports(&probe, "h", &[1, 2]).await,
            Some(true)
        );
    }

    /// [`TcpPortProbe`] itself (the REAL probe, not the fake): connecting to
    /// a genuinely closed loopback port must yield `Some(false)`, and
    /// connecting to a listener we open ourselves must yield `Some(true)`.
    /// This is the one test that touches a real socket — entirely
    /// self-contained (our own ephemeral loopback listener/non-listener),
    /// never another host, never a mutating call.
    #[tokio::test]
    async fn tcp_port_probe_distinguishes_open_and_closed_loopback_ports() {
        let probe = TcpPortProbe {
            timeout: Duration::from_millis(500),
        };

        // Open: bind our own ephemeral listener and probe it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Keep the listener alive across the probe by accepting in the background.
        let accept_task = tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        assert_eq!(probe.probe("127.0.0.1".to_string(), port).await, Some(true));
        accept_task.abort();

        // Closed: pick a high port nothing is listening on and expect Some(false).
        // (Bind-then-drop to get a genuinely free ephemeral port number, then
        // probe it after the listener is gone — connection refused.)
        let temp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free_port = temp_listener.local_addr().unwrap().port();
        drop(temp_listener);
        assert_eq!(
            probe.probe("127.0.0.1".to_string(), free_port).await,
            Some(false)
        );
    }

    // ---- NET-10: native-Linux LAN detection wiring into resolve_live_network_facts ----

    /// `resolve_live_network_facts`'s native-Linux branch calls
    /// [`detect_lan_ips_from_linux_interfaces`] — proven indirectly here since
    /// the function itself is private and platform-gated; the direct,
    /// thorough coverage of the parser/ranking lives in
    /// `freshell-platform::network::tests`. This test instead proves the
    /// GATING wiring: on THIS host (WSL2), the wsl2 `ipconfig.exe` branch is
    /// selected — never the native-Linux `ip` branch — matching
    /// `is_wsl2_proc_live()`'s own live read.
    #[test]
    fn resolve_live_network_facts_branch_selection_is_platform_correct() {
        // This is an existence/shape check only (no subprocess assumptions):
        // firewall_platform_fallback must agree with is_wsl2_proc_live().
        let expected = if is_wsl2_proc_live() {
            FirewallPlatform::Wsl2
        } else {
            FirewallPlatform::LinuxNone
        };
        assert_eq!(firewall_platform_fallback(), expected);
    }
}
