//! # Fresh-agent per-sessionRef create/resume lease (D8 for fresh agents)
//!
//! One durable `(provider, sessionId)` may have at most ONE in-flight create/resume
//! and at most ONE live bound session at a time — the JSONL/rollout transcript on disk
//! tolerates exactly one writer. Mirror of `TerminalRegistry`'s session-ref lease
//! INCLUDING its binding closure (registry.rs:1805-1885 and the TOCTOU fix at
//! registry.rs:1819-1844): a loser preempted across the winner's register→complete
//! window arrives after `complete()` removed the winner's lease — seeing no lease —
//! while only the bindings map records the winner. `claim` re-checks bindings WHILE
//! HOLDING the leases lock, so it answers [`FreshSessionClaim::BoundLive`] instead of
//! `Acquired` (never a duplicate spawn).
//!
//! Kill-before-release TTL semantics: an expired holder with a recorded kill handle is
//! answered [`FreshSessionClaim::ExpiredNeedsKill`] — the lease stays held until the
//! caller confirms the holder's ENTIRE process tree is dead (child kill + ownership
//! sweep empty) and calls [`FreshAgentSessionLeases::force_release_after_confirmed_kill`].
//! An expired HANDLE-LESS holder is revoked and held closed forever (never release what
//! you can't kill); its own `fail()` — proof no orphan exists — reopens the key.

use std::collections::HashMap;
use std::sync::Mutex;

/// Lease TTL: how long a create/resume may hold the sessionRef before contenders may
/// demand the kill-before-release path. Env `FRESHELL_FRESH_AGENT_LEASE_TTL_MS` overrides.
pub const FRESH_AGENT_SESSION_LEASE_TTL_MS: u64 = 20_000;
/// The `retry_after_ms` hint handed to `SESSION_RESERVED` losers.
pub const FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;

/// The effective lease TTL (env-overridable for tests).
pub fn fresh_agent_session_lease_ttl_ms() -> u64 {
    std::env::var("FRESHELL_FRESH_AGENT_LEASE_TTL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(FRESH_AGENT_SESSION_LEASE_TTL_MS)
}

/// Epoch milliseconds for lease claims (callers pass time in for testability of the
/// primitive; the seams use this shared clock).
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Kill an expired holder's sidecar TREE and confirm it is dead (Task 12, V6).
///
/// YAMA-aware design: under restricted ptrace (`/proc/sys/kernel/yama/ptrace_scope=1`,
/// the Ubuntu default) `/proc/<pid>/environ` is readable only while this process is an
/// ANCESTOR of the target — the moment the intermediate sidecar dies, its children
/// reparent to init and the ownership tag becomes unreadable. So the tagged tree is
/// captured FIRST (while the chain is intact), remembered as `(pid, starttime)` pairs,
/// and death is confirmed via the world-readable `/proc/<pid>/stat` with a starttime
/// match (the pid-reuse guard). Sequence:
///
/// 1. Scan the ownership-tagged `/proc` set (sidecar + SDK-spawned grandchildren).
/// 2. Graceful SIGTERM to the recorded child first (catchable — lets the SDK cleanly
///    kill its own CLI grandchild), poll ≤500ms, SIGKILL fallback.
/// 3. Sweep the captured tree (SIGTERM rounds, SIGKILL escalation) until every member
///    is confirmed dead-by-starttime, folding in any still-readable tagged newcomers.
///
/// b8ke focused round-5 review R5-4: every signal in this family is
/// IDENTITY-SAFE — issued through a pidfd pinned to the recorded
/// incarnation (see [`signal_recorded_incarnation`]). An unreadable or
/// missing start time is NEVER proof of liveness: no signal is issued
/// (fail-closed — the caller's unconfirmed path), and a pid recycled
/// between the verify and the send can never receive it.
///
/// Returns `true` only when the whole captured tree is confirmed gone; callers may
/// `force_release` ONLY then. Non-Linux: no `/proc` — returns `false` (hold closed).
#[cfg(target_os = "linux")]
pub async fn kill_and_confirm_tree_dead(pid: u32, ownership_env: &str, ownership_id: &str) -> bool {
    // 1. Capture the tagged tree BEFORE any kill (see YAMA note above).
    // The direct child's recorded start time — captured BEFORE any signal
    // so the grace wait and the escalation both revalidate the incarnation
    // (b8ke focused round-4 R4-8: a pid recycled mid-wait is never signaled).
    let child_start = proc_starttime(pid as i32);
    let mut tree: Vec<(i32, u64)> = scan_tagged_pids(ownership_env, ownership_id)
        .into_iter()
        .filter_map(|p| proc_starttime(p).map(|st| (p, st)))
        .collect();
    if !tree.iter().any(|(p, _)| *p == pid as i32) {
        if let Some(st) = child_start {
            tree.push((pid as i32, st));
        }
    }

    // 2. Graceful SIGTERM to the recorded child, poll, SIGKILL fallback —
    // both signals through the pinned incarnation (R5-4).
    if kill_recorded_child_unconfirmed(pid, child_start).await {
        return false;
    }

    // 3. Sweep the captured tree until confirmed empty (bounded; SIGKILL
    // escalation after 20 SIGTERM rounds). Re-scan folds in still-readable
    // tagged newcomers (covers the YAMA=0 case and children spawned after
    // the initial capture).
    sweep_captured_tree_until_dead(tree, ownership_env, ownership_id).await
}

/// The sweep behind [`kill_and_confirm_tree_dead`]'s step 3: poll the
/// captured `(pid, starttime)` tree until every member is confirmed
/// dead-by-starttime (SIGTERM rounds, SIGKILL escalation after 20 rounds),
/// folding in currently-readable tagged newcomers each round. R5-4: every
/// member signal is issued through the pidfd-pinned recorded incarnation —
/// a member whose identity cannot be pinned/verified is simply not
/// signaled that round (fail-closed; the next round's retain revalidates).
#[cfg(target_os = "linux")]
async fn sweep_captured_tree_until_dead(
    mut tree: Vec<(i32, u64)>,
    ownership_env: &str,
    ownership_id: &str,
) -> bool {
    for round in 0..24u8 {
        tree.retain(|(p, st)| proc_starttime(*p) == Some(*st));
        for p in scan_tagged_pids(ownership_env, ownership_id) {
            if !tree.iter().any(|(q, _)| *q == p) {
                if let Some(st) = proc_starttime(p) {
                    tree.push((p, st));
                }
            }
        }
        if tree.is_empty() {
            return true;
        }
        let sig = if round < 20 {
            libc::SIGTERM
        } else {
            libc::SIGKILL
        };
        for (p, st) in &tree {
            signal_recorded_incarnation(*p as u32, Some(*st), sig);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tree.retain(|(p, st)| proc_starttime(*p) == Some(*st));
    tree.is_empty()
}

/// b8ke focused round-3 review R3-7: the recorded identity of a condemned
/// runtime — the direct child's pid + its `/proc` start time and the tagged
/// descendant tree discovered at KILL TIME (while the ancestry chain was
/// still intact and the ownership tags readable). The replacement probe (a
/// cancelled/panicked teardown's finisher) verifies the pid's start time
/// BEFORE signaling (a recycled pid belongs to an unrelated process —
/// never signaled) and sweeps the RECORDED tree, so reparented descendants
/// whose tags became unreadable after the child died are still confirmed
/// dead-by-starttime — never an empty-tree false confirmation.
#[derive(Debug, Clone)]
pub struct CondemnedRuntimeIdentity {
    /// The direct sidecar child's pid at kill time.
    pub pid: u32,
    /// The child's `/proc` start time at kill time (`None` when unreadable
    /// or on non-Linux): the pid-reuse guard.
    pub start_time: Option<u64>,
    /// The tagged `(pid, starttime)` pairs discovered at kill time — the
    /// child plus its descendants, captured while readable.
    pub tree: Vec<(i32, u64)>,
    /// The ownership tag the tree was discovered under.
    pub ownership_id: String,
}

/// Capture a condemned runtime's identity NOW (kill time): the tagged tree
/// scan plus the direct child's start time. Cheap, sync, no signals.
#[cfg(target_os = "linux")]
pub fn record_condemned_runtime_identity(
    pid: u32,
    ownership_env: &str,
    ownership_id: &str,
) -> CondemnedRuntimeIdentity {
    let mut tree: Vec<(i32, u64)> = scan_tagged_pids(ownership_env, ownership_id)
        .into_iter()
        .filter_map(|p| proc_starttime(p).map(|st| (p, st)))
        .collect();
    if !tree.iter().any(|(p, _)| *p == pid as i32) {
        if let Some(st) = proc_starttime(pid as i32) {
            tree.push((pid as i32, st));
        }
    }
    CondemnedRuntimeIdentity {
        pid,
        start_time: proc_starttime(pid as i32),
        tree,
        ownership_id: ownership_id.to_string(),
    }
}

/// Non-Linux: no `/proc` — nothing can be captured (the direct child's
/// death remains the caller's portable floor; the fence stays held).
#[cfg(not(target_os = "linux"))]
pub fn record_condemned_runtime_identity(
    pid: u32,
    _ownership_env: &str,
    ownership_id: &str,
) -> CondemnedRuntimeIdentity {
    CondemnedRuntimeIdentity {
        pid,
        start_time: None,
        tree: Vec::new(),
        ownership_id: ownership_id.to_string(),
    }
}

/// The recorded-identity kill-and-confirm (b8ke focused round-3 R3-7):
/// like [`kill_and_confirm_tree_dead`] but driven by the identity captured
/// at kill time —
///
/// 1. The pid-reuse guard BEFORE any signal: a pid whose CURRENT start
///    time differs from the recorded one belongs to an unrelated
///    replacement process (the original incarnation is gone for the pid to
///    have been reused) — it is NEVER signaled; the sweep proceeds without
///    it.
/// 2. The graceful-then-forced direct-child kill — every signal issued
///    through a pidfd PINNED to the recorded incarnation (b8ke focused
///    round-5 R5-4: an unreadable start time or an unavailable pidfd is
///    NEVER proof of liveness — no signal is issued at all, and the kill
///    fails closed to the caller's unconfirmed path).
/// 3. The sweep runs over the RECORDED tree (reparented descendants whose
///    tags became unreadable are still confirmed dead-by-starttime) plus
///    any currently-readable tagged newcomers.
#[cfg(target_os = "linux")]
pub async fn kill_and_confirm_recorded_tree_dead(
    recorded: &CondemnedRuntimeIdentity,
    ownership_env: &str,
) -> bool {
    // The recorded start time is the identity license: the direct child's
    // signals ride the pidfd-pinned incarnation only (R5-4). No recorded
    // start time (the identity says the child was already gone at capture
    // — `proc_starttime` reads None for a dead or zombie process): NOTHING
    // is signaled on the bare pid (an unconfirmable identity never signals
    // its occupant) and the recorded tree alone is confirmed.
    if recorded.start_time.is_some()
        && kill_recorded_child_unconfirmed(recorded.pid, recorded.start_time).await
    {
        return false;
    }
    sweep_captured_tree_until_dead(recorded.tree.clone(), ownership_env, &recorded.ownership_id)
        .await
}

/// Non-Linux: no `/proc` — hold closed (the fence stays held).
#[cfg(not(target_os = "linux"))]
pub async fn kill_and_confirm_recorded_tree_dead(
    _recorded: &CondemnedRuntimeIdentity,
    _ownership_env: &str,
) -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
pub async fn kill_and_confirm_tree_dead(
    _pid: u32,
    _ownership_env: &str,
    _ownership_id: &str,
) -> bool {
    false
}

/// b8ke focused round-5 review R5-4: identity-safe signaling through a
/// pidfd PINNED to the recorded process incarnation. `pidfd_open` captures
/// the process currently holding the pid; the recorded start time is
/// reverified against that occupant and the signal is sent THROUGH the
/// pidfd — a pid recycled between the verify and the send can never
/// receive it (the pidfd addresses the original incarnation, and an exited
/// original answers ESRCH, not some replacement). Without a recorded
/// start time, or where the pidfd syscalls are unavailable (a kernel
/// without pidfd, or an unsupported architecture), the identity is
/// UNCONFIRMABLE: no signal is ever issued (fail-closed — the caller's
/// unconfirmed path, never a signal to a possibly-unrelated occupant).
#[cfg(target_os = "linux")]
mod pinned_signal {
    /// The unified-pool syscall numbers (stable ABI since Linux 5.3). The
    /// libc crate exports these only for some targets, so the numbers are
    /// declared for the architectures the pidfd path supports; every other
    /// Linux arch fails closed at runtime (the syscalls return `-ENOSYS`,
    /// [`super::signal_recorded_incarnation`] answers `Unconfirmable`).
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    const SYS_PIDFD_OPEN: libc::c_long = 434;
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    const SYS_PIDFD_SEND_SIGNAL: libc::c_long = 424;

    /// `pidfd_open(pid, 0)` — pin the process currently holding `pid`.
    /// `Err(1)` (`ESRCH`): NO process holds the pid — the recorded
    /// incarnation has provably exited (a process always holds its own
    /// pid while alive); `Err(other)`: the pidfd facility is unavailable
    /// (kernel/arch/permission) — the caller fails closed.
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    pub(super) fn open(pid: libc::pid_t) -> Result<i32, i32> {
        let fd = unsafe { libc::syscall(SYS_PIDFD_OPEN, pid, 0u32) };
        if fd >= 0 {
            Ok(fd as i32)
        } else {
            Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1))
        }
    }

    /// `pidfd_send_signal(pidfd, sig, NULL, 0)` — signal the PINNED
    /// incarnation exactly.
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    pub(super) fn send_signal(pidfd: i32, sig: libc::c_int) -> bool {
        unsafe {
            libc::syscall(
                SYS_PIDFD_SEND_SIGNAL,
                pidfd,
                sig,
                std::ptr::null::<libc::c_void>(),
                0u32,
            ) == 0
        }
    }
}

/// The outcome of an identity-safe signal attempt (R5-4).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IncarnationSignal {
    /// The signal was delivered through the pidfd to the recorded
    /// incarnation.
    Sent,
    /// The recorded incarnation is provably gone (a different process now
    /// holds the readable pid, or the pinned incarnation exited since the
    /// verify) — nothing was signaled and nothing of ours remains.
    Gone,
    /// The identity could not be pinned/verified (unreadable start time,
    /// unavailable pidfd) — NOTHING was signaled (fail-closed).
    Unconfirmable,
}

/// Issue ONE signal to the RECORDED process incarnation, identity-safe
/// (b8ke focused round-5 R5-4): pin the pid's current occupant with a
/// pidfd, verify the occupant still carries the recorded start time, and
/// send through the pidfd. Never signals an unconfirmable identity.
#[cfg(target_os = "linux")]
pub(crate) fn signal_recorded_incarnation(
    pid: u32,
    recorded_start: Option<u64>,
    sig: libc::c_int,
) -> IncarnationSignal {
    let Some(expected) = recorded_start else {
        // No recorded start time: the identity is unconfirmable — no
        // signal (fail-closed; the caller must NOT treat the pid's
        // occupant as the condemned child).
        return IncarnationSignal::Unconfirmable;
    };
    let pidfd = match pinned_signal::open(pid as libc::pid_t) {
        Ok(pidfd) => pidfd,
        // ESRCH: NO process holds the pid — the recorded incarnation has
        // provably exited (the strongest death proof available). Nothing
        // to signal; the caller proceeds to its tree confirmation.
        Err(libc::ESRCH) => return IncarnationSignal::Gone,
        // pidfd unavailable (kernel/arch without it, permission): without
        // the pin there is no identity-safe send — no signal.
        Err(_) => return IncarnationSignal::Unconfirmable,
    };
    let sent = match proc_starttime(pid as i32) {
        // STILL the recorded incarnation at this instant — and the pidfd
        // pins that same occupant, so the send below cannot reach a
        // recycled replacement even if the pid turns over between this
        // verify and the send.
        Some(actual) if actual == expected => {
            let sent = pinned_signal::send_signal(pidfd, sig);
            // `false` here is ESRCH: the pinned incarnation exited since
            // the verify — provably gone, never a replacement.
            sent
        }
        // A DIFFERENT readable process holds the pid: the original
        // incarnation is provably gone (the pid was reused) — never
        // signaled. The same holds for an UNREADABLE pid: `proc_starttime`
        // reads None exactly for a gone, zombie, or exited process (the
        // wait discipline's proof of death) — nothing to signal, nothing
        // of ours remains.
        Some(_) | None => false,
    };
    unsafe { libc::close(pidfd) };
    if sent {
        IncarnationSignal::Sent
    } else {
        IncarnationSignal::Gone
    }
}

/// The direct child's graceful-then-forced kill with EVERY signal issued
/// through the pidfd-pinned recorded incarnation (b8ke focused round-5
/// R5-4). Returns `true` when the child's death could NOT be confirmed —
/// the caller must fail closed (its unconfirmed path), never claim the
/// reap. `recorded_start: None` (dead at capture per the identity
/// contract) skips signaling entirely; the recorded tree alone is
/// confirmed by the caller's sweep.
#[cfg(target_os = "linux")]
async fn kill_recorded_child_unconfirmed(pid: u32, recorded_start: Option<u64>) -> bool {
    let Some(expected) = recorded_start else {
        return false;
    };
    match signal_recorded_incarnation(pid, recorded_start, libc::SIGTERM) {
        IncarnationSignal::Sent => {}
        // The recorded incarnation is provably gone — nothing to kill.
        IncarnationSignal::Gone => return false,
        // Unconfirmable identity: NO signal was issued — fail closed.
        IncarnationSignal::Unconfirmable => {
            tracing::warn!(target: "freshell_freshagent::session_lease",
                pid, expected_start_time = expected,
                "session_lease.condemned_child_unconfirmable: the recorded child's identity \
                 could not be pinned/verified — no signal issued (fail-closed)"
            );
            return true;
        }
    }
    if wait_recorded_incarnation_gone(pid, recorded_start).await {
        return false;
    }
    // R4-8/R5-4: the escalation signal re-pins and re-verifies the
    // recorded incarnation immediately before firing — only the ORIGINAL
    // process is ever SIGKILLed, through the pidfd.
    match signal_recorded_incarnation(pid, recorded_start, libc::SIGKILL) {
        IncarnationSignal::Sent => {}
        // Exited (or turned over) since the grace wait — provably gone.
        IncarnationSignal::Gone => return false,
        IncarnationSignal::Unconfirmable => {
            tracing::warn!(target: "freshell_freshagent::session_lease",
                pid, expected_start_time = expected,
                "session_lease.condemned_child_escalation_unconfirmable: the escalation \
                 signal could not be pinned to the recorded incarnation — not issued"
            );
            return true;
        }
    }
    !wait_recorded_incarnation_gone(pid, recorded_start).await
}

/// b8ke focused round-4 review R4-8: is `pid` still the RECORDED process
/// incarnation? With a recorded start time, the pid belongs to the
/// original process iff `/proc` still shows EXACTLY that start time — a
/// recycled pid (the original died; an unrelated process took the id)
/// reads a DIFFERENT start time and is never "ours". Without a recorded
/// start time (the legacy discipline), pid existence alone is the best
/// available identity.
#[cfg(target_os = "linux")]
pub(crate) fn pid_is_recorded_incarnation(pid: u32, recorded_start: Option<u64>) -> bool {
    match recorded_start {
        Some(expected) => matches!(proc_starttime(pid as i32), Some(actual) if actual == expected),
        None => proc_starttime(pid as i32).is_some(),
    }
}

/// b8ke focused round-4 review R4-8: the RECORDED-INCARNATION grace wait —
/// the kill path's quiescence poll. The pid counts as gone when it is no
/// longer the recorded incarnation: dead/zombie (`starttime` reads None)
/// OR RECYCLED (a different start time — the original incarnation is
/// provably dead and the replacement must never be signaled, so the wait
/// reports gone instead of letting the escalation fire at the unrelated
/// process). Bounded: 20 × 25ms, then a final check.
#[cfg(target_os = "linux")]
async fn wait_recorded_incarnation_gone(pid: u32, recorded_start: Option<u64>) -> bool {
    for _ in 0..20u8 {
        if !pid_is_recorded_incarnation(pid, recorded_start) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    !pid_is_recorded_incarnation(pid, recorded_start)
}

/// The process's `starttime` (field 22 of `/proc/<pid>/stat`, world-readable — no
/// ptrace needed), or `None` when the pid is gone, a zombie, or dead (`Z`/`X` state).
/// `(pid, starttime)` uniquely identifies a process incarnation: a recycled pid gets a
/// new starttime, so comparing both is the pid-reuse guard. `pub(crate)` for the claude
/// lane's confirmed-reap capture (b8ke delta review F2).
#[cfg(target_os = "linux")]
pub(crate) fn proc_starttime(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm (field 2) may contain spaces/parens: split at the LAST ')' — the remainder
    // starts at field 3 (state), so starttime (field 22) is index 19 there.
    let rest = stat.rsplit(')').next()?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    match fields.first() {
        Some(&"Z") | Some(&"X") | None => return None,
        Some(_) => {}
    }
    fields.get(19)?.parse().ok()
}

/// All live pids whose `/proc/<pid>/environ` carries `{env}={id}` (the ownership tag
/// the sidecar AND its SDK-spawned grandchildren inherit). Readable only for processes
/// this process may ptrace (YAMA) — see [`kill_and_confirm_tree_dead`]'s capture-first
/// design for why that constraint is handled there.
#[cfg(target_os = "linux")]
fn scan_tagged_pids(ownership_env: &str, ownership_id: &str) -> Vec<i32> {
    let needle = format!("{ownership_env}={ownership_id}");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        let environ = std::path::Path::new("/proc").join(name).join("environ");
        let Ok(bytes) = std::fs::read(environ) else {
            continue;
        };
        if bytes.split(|b| *b == 0).any(|kv| kv == needle.as_bytes()) {
            out.push(pid);
        }
    }
    out
}

/// The answer to a [`FreshAgentSessionLeases::claim`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshSessionClaim {
    /// The caller now holds the lease — it may spawn/resume, and MUST end with
    /// `complete()` (session registered) or `fail()` (released).
    Acquired,
    /// Another holder is in flight (or a revoked holder is held closed). The caller
    /// answers its client `SESSION_RESERVED { retryable: true }`.
    Held { retry_after_ms: u64 },
    /// The holder expired with a recorded kill handle: the caller must confirm the
    /// holder's ENTIRE tree dead (kill + ownership sweep), then
    /// `force_release_after_confirmed_kill` and re-claim ONCE.
    ExpiredNeedsKill { pid: u32, ownership_id: String },
    /// A completed winner's LIVE session owns this durable id (binding map hit,
    /// answered under the same lock) — the caller must ADOPT, never spawn.
    BoundLive { live_session_key: String },
}

struct LeaseEntry {
    holder_request_id: String,
    acquired_at_ms: u64,
    kill_handle: Option<(u32 /* pid */, String /* ownership_id */)>,
    revoked: bool,
}

#[derive(Default)]
struct Inner {
    leases: HashMap<String, LeaseEntry>,
    /// durable key -> live sessions-map key, recorded by `complete()` UNDER THE SAME
    /// LOCK as the lease removal (registry.rs:1931-1940: releasing first and binding
    /// under a separate lock opens a no-lease/no-binding window -> a second spawn).
    bindings: HashMap<String, String>,
}

fn lease_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{0}{session_id}")
}

/// The lease map: ONE `Mutex` over both the leases and the bindings maps, so every
/// claim/complete decision is atomic with respect to the binding record.
#[derive(Default)]
pub struct FreshAgentSessionLeases {
    inner: Mutex<Inner>,
}

impl FreshAgentSessionLeases {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `(provider, session_id)` for `holder_request_id` at `now_ms`. Checks the
    /// BINDINGS map FIRST, under the same lock as the lease map — the under-the-lock
    /// TOCTOU re-check. Caller pre-checks via `has_live_session` are a fast path ONLY,
    /// never the defense (a miss→win→release→duplicate-spawn interleaving is
    /// constructible without this).
    pub fn claim(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        now_ms: u64,
    ) -> FreshSessionClaim {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        // TOCTOU closure (registry.rs:1819-1844): a loser arriving after the winner's
        // complete() removed the lease sees the BINDING instead of an empty map.
        if let Some(live) = inner.bindings.get(&key) {
            return FreshSessionClaim::BoundLive {
                live_session_key: live.clone(),
            };
        }
        match inner.leases.get_mut(&key) {
            None => {
                inner.leases.insert(
                    key,
                    LeaseEntry {
                        holder_request_id: holder_request_id.to_string(),
                        acquired_at_ms: now_ms,
                        kill_handle: None,
                        revoked: false,
                    },
                );
                FreshSessionClaim::Acquired
            }
            Some(lease) => {
                let expired = now_ms
                    > lease
                        .acquired_at_ms
                        .saturating_add(fresh_agent_session_lease_ttl_ms());
                if !expired || lease.revoked {
                    // Re-claims by the SAME holder_request_id also answer Held: the
                    // original task is still running; idempotent re-sends are answered
                    // by the per-requestId dedup, not the lease.
                    return FreshSessionClaim::Held {
                        retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS,
                    };
                }
                match &lease.kill_handle {
                    Some((pid, ownership_id)) => FreshSessionClaim::ExpiredNeedsKill {
                        pid: *pid,
                        ownership_id: ownership_id.clone(),
                    },
                    None => {
                        lease.revoked = true;
                        tracing::error!(target: "invariant", provider, session_id,
                            holder = %lease.holder_request_id,
                            "fresh_agent_session_lease_revoked: expired handle-less holder — holding closed");
                        FreshSessionClaim::Held {
                            retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS,
                        }
                    }
                }
            }
        }
    }

    /// Arm the TTL kill path once the sidecar child pid AND its ownership tag are known
    /// (the tag drives the tree-kill sweep — a bare pid misses the SDK-spawned
    /// grandchild writer). No-op if the lease is gone or foreign.
    pub fn set_kill_handle(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        pid: u32,
        ownership_id: &str,
    ) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        if let Some(lease) = inner.leases.get_mut(&key) {
            if lease.holder_request_id == holder_request_id {
                lease.kill_handle = Some((pid, ownership_id.to_string()));
            }
        }
    }

    /// Winner registered its session: insert `bindings[key] = live_session_key` and
    /// remove the lease IN THE SAME LOCK SCOPE. Returns `false` if the lease was
    /// revoked or foreign — the caller must tear down its own child and fail loudly
    /// (no binding recorded, lease untouched for foreign / held closed for revoked).
    pub fn complete(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        live_session_key: &str,
    ) -> bool {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        match inner.leases.get(&key) {
            Some(lease) if lease.holder_request_id == holder_request_id && !lease.revoked => {
                inner.leases.remove(&key);
                inner.bindings.insert(key, live_session_key.to_string());
                true
            }
            _ => false,
        }
    }

    /// Spawn/resume failed: release. Safe for revoked leases — a holder calling
    /// `fail()` proves no orphan exists, so the key reopens.
    pub fn fail(&self, provider: &str, session_id: &str, holder_request_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        if let Some(lease) = inner.leases.get(&key) {
            if lease.holder_request_id == holder_request_id {
                inner.leases.remove(&key);
            }
        }
    }

    /// The bound live session exited: session exit watchers MUST call this or the
    /// durable id stays adopt-only forever.
    pub fn clear_binding(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        inner.bindings.remove(&lease_key(provider, session_id));
    }

    /// Only legal after the holder's ENTIRE process tree death was confirmed
    /// (child kill + ownership sweep empty). Also clears any binding — the whole
    /// tree is confirmed dead.
    pub fn force_release_after_confirmed_kill(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        inner.leases.remove(&key);
        inner.bindings.remove(&key);
    }

    /// kata b8ke Task 3: the CURRENT holder's armed kill handle, if any —
    /// the ownership watchdog's `kill_raw_for_watchdog` reaps an
    /// uncommitted, over-aged spawn's sidecar with the same `(pid,
    /// ownership tag)` pair the TTL expiry path kills by. Read-only; the
    /// lease itself is untouched.
    pub fn peek_kill_handle(&self, provider: &str, session_id: &str) -> Option<(u32, String)> {
        let inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        inner
            .leases
            .get(&lease_key(provider, session_id))
            .and_then(|lease| lease.kill_handle.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: u64 = FRESH_AGENT_SESSION_LEASE_TTL_MS;

    #[test]
    fn first_claim_acquires_second_is_held() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(
            leases.claim("claude", "sid-1", "req-a", 1_000),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", 1_100),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
    }

    #[test]
    fn different_sessions_and_providers_do_not_contend() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(
            leases.claim("claude", "sid-1", "req-a", 0),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("claude", "sid-2", "req-b", 0),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("codex", "sid-1", "req-c", 0),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn winner_fail_releases_so_loser_acquires() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        leases.fail("codex", "sid-1", "req-a");
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 10),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn winner_complete_records_binding_and_loser_claim_answers_bound_live() {
        // THE TOCTOU PIN (registry.rs:1819-1844's exact window, no threads needed):
        // a loser preempted across the winner's register -> complete window must see
        // BoundLive — NEVER Acquired — after complete removed the winner's lease.
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 10),
            FreshSessionClaim::BoundLive {
                live_session_key: "live-key-1".into()
            }
        );
    }

    #[test]
    fn clear_binding_reopens_after_the_bound_session_exits() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        leases.clear_binding("codex", "sid-1");
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 20),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn expired_with_kill_handle_needs_kill_then_force_release_reopens() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-a", 4242, "own-1");
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::ExpiredNeedsKill {
                pid: 4242,
                ownership_id: "own-1".into()
            }
        );
        // lease is still held until the tree-kill is confirmed
        assert_eq!(
            leases.claim("claude", "sid-1", "req-c", TTL + 2),
            FreshSessionClaim::ExpiredNeedsKill {
                pid: 4242,
                ownership_id: "own-1".into()
            }
        );
        leases.force_release_after_confirmed_kill("claude", "sid-1");
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 3),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn expired_pidless_is_revoked_and_held_closed_and_late_complete_fails() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("opencode", "ses-1", "req-a", 0);
        assert_eq!(
            leases.claim("opencode", "ses-1", "req-b", TTL + 1),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
        // revoked holder must tear down (no binding recorded)
        assert!(!leases.complete("opencode", "ses-1", "req-a", "live-x"));
        // fail() by the revoked holder proves no orphan exists and reopens
        leases.fail("opencode", "ses-1", "req-a");
        assert_eq!(
            leases.claim("opencode", "ses-1", "req-b", TTL + 2),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn set_kill_handle_by_foreign_request_is_a_no_op() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-INTRUDER", 999, "own-x");
        // still handle-less: expiry revokes instead of ExpiredNeedsKill
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
    }

    /// b8ke focused round-4 review R4-8: the grace wait (and the
    /// escalation decision after it) must revalidate the RECORDED start
    /// time — a pid that now belongs to a DIFFERENT incarnation was
    /// recycled while the original died, so the original is provably gone
    /// and the replacement must NEVER be signaled. Pre-fix, the grace
    /// wait polled PID EXISTENCE alone: a recycled pid made the wait
    /// answer "still alive" and the escalation SIGKILLed the unrelated
    /// replacement process.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_grace_wait_treats_a_recycled_pid_as_gone_and_never_escalates() {
        // A live "unrelated replacement" process holding the recorded pid.
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated replacement");
        let pid = unrelated.id().expect("unrelated pid");
        // The recorded identity: the pid with the ORIGINAL (dead)
        // incarnation's start time — forged to differ from the
        // replacement's, the exact pid-reuse shape.
        let recorded_start = proc_starttime(pid as i32).expect("the replacement's start time") + 1;

        let began = std::time::Instant::now();
        let gone = wait_recorded_incarnation_gone(pid, Some(recorded_start)).await;
        assert!(
            gone,
            "a recycled pid's original incarnation is gone — the wait must report it gone"
        );
        assert!(
            began.elapsed() < std::time::Duration::from_secs(1),
            "the incarnation mismatch must be detected on the first poll, not the bounded window"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the reused pid's unrelated process must never be signaled"
        );
        let _ = unrelated.kill().await;
    }

    /// b8ke focused round-4 review R4-8 (the matching-incarnation control):
    /// a pid that still carries the RECORDED start time is the original
    /// process — the wait must report it STILL PRESENT after the bounded
    /// window so the escalation signal stays licensed for exactly that
    /// incarnation.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_grace_wait_reports_a_live_recorded_incarnation_still_present() {
        let mut child = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the recorded child");
        let pid = child.id().expect("child pid");
        let recorded_start = proc_starttime(pid as i32).expect("the child's start time");

        let still_present = !wait_recorded_incarnation_gone(pid, Some(recorded_start)).await;

        assert!(
            still_present,
            "the recorded incarnation is alive — the wait must report it still present"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the wait itself never signals — the live recorded incarnation survives it"
        );
        let _ = child.kill().await;
    }
    /// b8ke focused round-4 review R4-8 (the kill-path contract): a
    /// recorded identity whose pid belongs to an UNRELATED incarnation is
    /// never signaled at ANY point of the kill-and-confirm — the original
    /// is provably dead (only its recycled pid remains) and the
    /// confirmation proceeds through the recorded tree alone.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_recorded_kill_path_never_signals_a_recycled_pid() {
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated replacement");
        let pid = unrelated.id().expect("unrelated pid");
        let recorded = CondemnedRuntimeIdentity {
            pid,
            start_time: Some(proc_starttime(pid as i32).expect("start time") + 1),
            tree: Vec::new(),
            ownership_id: "r48-kill-path".to_string(),
        };

        let confirmed = kill_and_confirm_recorded_tree_dead(&recorded, "R48_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the original incarnation is provably gone (its pid was recycled) — confirmed"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the recycled pid's unrelated process must survive the whole kill-and-confirm"
        );
        let _ = unrelated.kill().await;
    }

    /// b8ke focused round-5 review R5-4: an UNCONFIRMABLE identity never
    /// signals. A recorded identity with NO start time cannot prove the
    /// pid's current occupant is the condemned child — pre-fix the guard
    /// treated it as "live" and SIGTERMed (then SIGKILLed) whatever held
    /// the pid, so a recycled occupant died. Post-fix the direct-child
    /// signals are licensed ONLY through a pidfd pinned to the RECORDED
    /// incarnation (verified before every send); with no identity there
    /// is no signal, and the recorded tree alone is confirmed.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn an_unconfirmable_identity_never_signals_the_pids_occupant() {
        // A live process holding the recorded pid — under the forged
        // identity it is an unrelated occupant (the identity claims the
        // condemned child was already gone at capture time).
        let mut occupant = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated occupant");
        let pid = occupant.id().expect("occupant pid");
        let unconfirmable = CondemnedRuntimeIdentity {
            pid,
            start_time: None,
            tree: Vec::new(),
            ownership_id: "r54-unconfirmable".to_string(),
        };

        let confirmed =
            kill_and_confirm_recorded_tree_dead(&unconfirmable, "R54_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the recorded identity says the child was dead at capture — the empty recorded \
             tree is confirmed without any signal"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the UNCONFIRMABLE identity must never signal the pid's occupant"
        );
        let _ = occupant.kill().await;
    }

    /// b8ke focused round-5 review R5-4 (the pinned-signal positive
    /// control): a CONFIRMABLE identity — the pid still carrying the
    /// recorded start time — is signaled through the pidfd and the
    /// kill-and-confirm settles its death.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_recorded_incarnation_is_killed_through_the_pinned_pidfd() {
        let mut child = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the recorded child");
        let pid = child.id().expect("child pid");
        let recorded = CondemnedRuntimeIdentity {
            pid,
            start_time: proc_starttime(pid as i32),
            tree: Vec::new(),
            ownership_id: "r54-pinned".to_string(),
        };

        let confirmed = kill_and_confirm_recorded_tree_dead(&recorded, "R54_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the pinned-incarnation kill must confirm the recorded child's death"
        );
        assert!(
            proc_starttime(pid as i32).is_none(),
            "the recorded child itself was signaled (through the pidfd) and is dead"
        );
        let _ = child.kill().await;
    }
}
