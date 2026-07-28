# NET-08 adversarial security audit — Rust network-mutation surface

**Date:** 2026-07-28
**Auditor role:** adversarial reviewer, pre-untrusted-LAN gate
**Base audited:** `main` @ `6537d65c` (working tree clean apart from untracked plan docs)
**Method:** read the code as shipped; live probes against the running Rust server on
port 3002; a throwaway PoC integration test (`crates/freshell-platform/tests/tmp_audit_poc.rs`,
written, executed, and **removed** — the tree is clean).

---

## 0. Headline: the audited feature does not exist yet

The brief asks me to audit `configure`, `disable-remote-access`, `configure-firewall`,
and `lan-info`. **None of these routes exist on `main`, in any worktree, or on any
branch.** This is the single most important finding, and it reframes every other item.

Route inventory, taken from the actual router registrations
(`crates/freshell-server/src/main.rs:896-962`):

```
/api/network/status                 <- the ONLY network route (GET, read-only)
/api/network/configure              <- absent
/api/network/disable-remote-access  <- absent
/api/network/configure-firewall     <- absent
/api/lan-info                       <- absent
```

Verified live against the running server (token from `.env`):

| Path | no token | valid token GET | valid token POST |
|---|---|---|---|
| `/api/network/status` | **401** | 200 | 405 |
| `/api/network/configure` | **401** | 404 | 404 |
| `/api/network/disable-remote-access` | **401** | 404 | 404 |
| `/api/network/configure-firewall` | **401** | 404 | 404 |
| `/api/lan-info` | **401** | 404 | 404 |

(The 401-before-404 on unmatched paths comes from the authenticated SPA fallback at
`main.rs:963-971` — unauthenticated callers cannot even probe which routes exist.)

Exhaustive search confirming absence:

```
grep -rn "api/network/configure|api/network/disable|api/lan-info" --include=*.rs crates/ .worktrees/   -> 0 hits
for b in $(git branch -a); do git grep -l "api/network/configure" $b -- 'crates/*'; done               -> 0 hits
```

Consequently the mutation-specific questions (2, 4, 5, and the HTTP half of 1 and 3)
have **no implementation to audit**. I audited what actually ships — the read route,
the auth gate, the builder/gate primitives that the future routes will call, the
logging layer, and the execution guard — and I recorded what the primitives will do
*the moment they are wired*, because that is where the real risk sits.

I want to be explicit about what this means for the verdict: **"no findings" here is
overwhelmingly a statement about absent code, not about proven-safe code.** Passing
this audit is not evidence that the surface is ready for an untrusted LAN. A re-audit
is mandatory once the mutating routes land.

---

## 1. AUTH — mutating routes, `lan-info`, `status`

**Status: PASS for what exists; N/A for the four absent routes.**

`GET /api/network/status` (`crates/freshell-server/src/network.rs:90-93`) checks auth as
the **very first statement**, before the `OnceCell` live-facts resolution at `:97-111`
that spawns read-only subprocesses:

```rust
async fn network_status(State(state): State<NetworkState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();          // network.rs:91-93
    }
    let facts = state.facts.get_or_init(...)          // expensive work strictly after
```

This ordering is correct and matters: it means an unauthenticated caller cannot make the
server fork `netsh.exe`/`ipconfig.exe`, so there is no pre-auth subprocess-amplification
DoS.

The gate itself (`crates/freshell-server/src/boot.rs:686-708`) accepts `x-auth-token` or
the `freshell-auth` cookie, rejects empty values, and compares via
`freshell_api::constant_time_eq` (`crates/freshell-api/src/lib.rs:91-100`) — a
length-check-then-XOR-accumulate loop with no early exit. Live: missing token → 401,
wrong token → 401.

**Note (not a finding, a requirement for the next slice):** `is_authed` is applied
per-handler, not as a router-wide layer. Every one of the four new mutating routes must
repeat that call as its first statement. Given the pattern, a single omission is a
critical auth bypass, and nothing structural prevents it. I recommend the mutating
routes be mounted behind a `middleware::from_fn` auth layer rather than relying on
four hand-written copies.

---

## 2. INPUT — unknown fields, wrong types, hostile hosts

**Status: N/A for the absent routes. The adjacent live path that writes the same
state (`PATCH /api/settings`) is SOUND on hostile hosts; one lenient behavior noted
as informational.**

The `host` value is not a free string. It is a closed enum
(`crates/freshell-protocol/src/settings.rs:29-35`):

```rust
pub enum NetworkHost {
    #[serde(rename = "127.0.0.1")]  Loopback,
    #[serde(rename = "0.0.0.0")]    AllInterfaces,
}
```

Serde will only ever deserialize those two literals, so hostile host strings cannot
reach `SettingsNetwork.host` through any JSON path. Verified live against
`PATCH /api/settings`:

| Body (network slice) | Result |
|---|---|
| `{"configured":true,"host":"0.0.0.0; rm -rf /"}` | **400** `{"error":"Invalid request"}` |
| `{"configured":true,"host":"::1%eth0"}` | **400** |
| `{"configured":true,"host":"<5000×'A'>"}` | **400** |
| `{"configured":"yes","host":"127.0.0.1"}` (wrong type) | **400** |
| `{"configured":true,"host":"127.0.0.1","evil":1}` (unknown field) | 200, `evil` **not persisted** |

I confirmed no state change on the rejected requests, and confirmed the unknown field
is dropped rather than stored (`~/.freshell/config.json` contains no `evil` key; the
`network` slice reads `{"configured": true, "host": "0.0.0.0"}`).

**INFO-1 — unknown fields are silently ignored, not rejected (informational, not a
finding).** No `deny_unknown_fields` anywhere in `settings.rs` / `settings_store.rs`.
This is not exploitable — unknown keys are dropped on the floor — but it means a
client typo (`hosts:` for `host:`) silently no-ops instead of erroring. If the brief's
"unknown fields rejected 400" is a hard contract for the new mutating routes, they will
need `#[serde(deny_unknown_fields)]` explicitly; they will not inherit it.

**Disclosure:** these probes mutated live settings (`network.configured` / `host`) on the
running server. Final persisted state is `{"configured": true, "host": "0.0.0.0"}`, which
matches the pre-probe state — the accepted requests wrote the values that were already
there. No restart was performed and no approval was required.

---

## 3. COMMAND CONSTRUCTION — the real risk

This is where the substantive findings are. I traced every path from input to a command
string across `elevated.rs`, `firewall.rs`, and `port_forward.rs`.

### 3a. Quoting analysis of `build_elevated_powershell_args` — CORRECT

`crates/freshell-platform/src/elevated.rs:24-30`:

```rust
let escaped = script.replace('\'', "''");
format!("Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '{escaped}'")
```

The `'` → `''` doubling is the correct escape for a PowerShell **single-quoted** literal.
Single-quoted PowerShell strings do not interpolate `$`, backtick, or `"`, so the only
way out of the literal is a bare `'`, and that is exactly what is doubled. I attacked it
directly with `1.2.3.4' ; calc ; '` and confirmed the quotes come out doubled with no
breakout:

```
... connectaddress=1.2.3.4'' ; calc ; '' connectport=3001; ...
```

The argv is also passed as a real vector to `std::process::Command::args`
(`crates/freshell-platform/src/lib.rs:314-324`) — **no shell, no `cmd.exe`, no
`ArgvQuote` round-trip**. So `cmd` metacharacters (`&`, `|`, `^`, `%VAR%`) are inert at
this layer. The quoting function is not the weakness.

### 3b. FINDING NET08-A — unvalidated `wsl_ip` is injected into the elevated script body

**Severity: MEDIUM as shipped (unreachable — no caller, no route). HIGH the moment
`configure`/`configure-firewall` is wired and passes an attacker-influenced IP.**

**Location:** `crates/freshell-platform/src/port_forward.rs:327-345`, specifically the
interpolation at `:338`; propagated via `build_wsl_port_forwarding_plan`
(`:413-471`, script built at `:465`, normalized at `:468`).

```rust
pub fn build_port_forwarding_script(wsl_ip: &str, ports: &[u16], cleanup_ports: &[u16]) -> String {
    ...
    cmds.push(format!(
        "netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 \
listenport={port} connectaddress={wsl_ip} connectport={port}"   // :338 — raw interpolation
    ));
```

`wsl_ip` is a `&str` with **no validation at this boundary**. Ports are `u16` and
therefore safe; the rule name is a hardcoded space-free constant; `wsl_ip` is the sole
free-form value in the entire script.

The escaping in 3a does **not** save you here, because the injected content is placed
*inside* the script that is then wrapped — the attacker's `;` is a legitimate PowerShell
statement separator within the single-quoted `-Command` payload, which PowerShell parses
after unwrapping. PoC (executed, output verbatim):

```
input  wsl_ip = "1.2.3.4; Start-Process calc.exe; #"

script = netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3001
         connectaddress=1.2.3.4; Start-Process calc.exe; # connectport=3001; ...

elevated arg[1] = Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command',
         '... connectaddress=1.2.3.4; Start-Process calc.exe; # connectport=3001; ...'
```

The trailing `#` comments out the rest of the line, yielding a clean injected statement
that would execute **elevated, post-UAC**. No quote characters are needed, so the `''`
escaping is bypassed entirely rather than defeated.

I also confirmed the full plan builder propagates it (`build_wsl_port_forwarding_plan`
with `wsl_ip = "1.2.3.4; calc.exe"` → `Ready { script }` containing `calc.exe`), so the
defect is not confined to the low-level builder.

**Why it is only MEDIUM today:** `build_port_forwarding_script`,
`build_firewall_only_script`, `build_port_forwarding_teardown_script`,
`spawn_elevated_powershell`, and `ConfirmationGate::request_elevation` have **zero
non-test callers** (grep across all of `crates/`; the only hits are the `pub use`
re-exports at `lib.rs:68,81`). Nothing can reach line 338 at runtime.

**Exploit sketch (post-wiring).** The intended producer is `get_wsl_ip`
(`port_forward.rs:549-559`), which parses `ip -4 addr show eth0` / `hostname -I`. Both
parsers **do** validate with `is_ipv4_shape` (`:111-118`, `:529`, `:543`), so the
*intended* path is currently safe. The exposure is that the safety is an accident of the
producer, not a property of the consumer:
1. A future `POST /api/network/configure` accepts a caller-supplied or
   config-supplied connect address (an entirely natural API shape for this feature);
2. it flows to `build_port_forwarding_script` as `wsl_ip`;
3. the operator clicks through the UAC prompt they were already going to click;
4. the injected statement runs as Administrator.

**Recommended fix (fix the system, not the symptom):** make the type system carry the
guarantee. Introduce a validated `Ipv4Addr`-backed newtype (or take `std::net::Ipv4Addr`
directly) as the parameter type of `build_port_forwarding_script` /
`build_wsl_port_forwarding_plan`, so an unvalidated string is a **compile error** rather
than a code-review obligation. `is_ipv4_shape` should be enforced at the builder
boundary, not only at the two parsers. Add a red test asserting a hostile IP is rejected.

### 3c. FINDING NET08-B — newline smuggling is not blocked

**Severity: LOW as shipped (same unreachability as NET08-A; strictly a sub-case of it).**

**Location:** same interpolation, `port_forward.rs:338`.

Neither the builder nor `build_elevated_powershell_args` strips or rejects `\r` / `\n`.
PoC output shows a literal newline surviving into `arg[1]`:

```
... connectaddress=1.2.3.4
Start-Process calc.exe
 connectport=3001; ...
```

In a PowerShell single-quoted here-string context a newline is a statement separator, so
this is a second injection primitive that does not require `;`. Same root cause and same
fix as NET08-A — an `Ipv4Addr` type makes both impossible.

### 3d. `2>\$null` → `2>$null` normalization — CORRECT, and worth stating why

`normalize_script_for_elevated_powershell` (`port_forward.rs:264-266`) does
`script.replace("\\$", "$")`. This looked like a candidate escaping bug, so I checked it
adversarially: it is a **de-escaping** step, and it only ever removes a backslash before
a `$`. It cannot introduce a quote, a `;`, or a newline, and it runs on a string whose
only variable component is `wsl_ip` (already covered by NET08-A). It does not widen the
attack surface. The dual-form convention (raw `2>\$null` for the `sh`-interpolated path,
normalized `2>$null` for the direct-to-PowerShell path) is documented at
`port_forward.rs:6-13` and `firewall.rs:13-19` and is golden-tested both ways.

### 3e. `firewall.rs` builders — SOUND

Every builder in `firewall.rs` interpolates **only `u16` ports**:
`build_windows_firewall_delete_commands` (`:248-258`),
`build_windows_firewall_add_commands` (`:261-272`),
`build_windows_firewall_repair_commands` (`:278-305`),
`managed_windows_firewall_rule_name` (`:230-232`),
`firewall_commands` (`:190-223`). A `u16` renders as 1–5 digits; no metacharacter is
representable. `get_existing_managed_windows_firewall_ports` (`:313-331`) builds
`name=Freshell (port <u16>)` and passes it as a **single argv element**, not through a
shell — the spaces and parens are inert.

The `linux-ufw` / `linux-firewalld` / `macos` outputs from `firewall_commands` are
`sudo …` strings, but they are returned as **data** in the status JSON for the user to
copy-paste (`network.rs:163-169, 207`) and are never executed. Confirmed: no non-test
caller executes them.

### 3f. Answer to "can ANY request byte reach a shell/PowerShell string unescaped?"

**Today: no.** There is no request path that reaches any command builder. The one live
subprocess path (`resolve_live_network_facts`, `network.rs:225-256`) takes **no request
input at all** — `detect_firewall`, `detect_lan_ips_via_ipconfig`
(`network.rs:371-377`), and `detect_lan_ips_from_windows_interfaces`
(`network.rs:459-472`) run fixed argv with a hardcoded `WINDOWS_IP_PROBE` constant.

**Post-wiring: yes, via `wsl_ip`, unless NET08-A is fixed first.** That is the single
seam to close.

---

## 4. TOKEN PROTOCOL — one-time, action-bound, constant-time, consumed

**Status: MIXED. Correct on one-time/action-bound; one genuine defect (non-constant-time
comparison); consumption-on-failure differs from the brief's expectation.**

The gate is `ConfirmationGate` (`elevated.rs:136-266`), currently **unconstructed outside
its own tests**.

**One-time — PASS.** `consume_confirmation` (`:177-188`) sets `self.current = None` on
match, so a replay falls to the mismatch branch and re-issues instead of spawning.
Asserted by `phase2_matching_token_spawns_via_injected_fake` (`:408`).

**Action-bound — PASS.** `matches_confirmation` (`:168-173`) requires
`c.token == t && c.action == action`. A `windows-repair` token presented for
`wsl2-disable` fails, falls into the phase-1 branch at `:242-244`, and returns
`Issued` **without spawning**. Cross-action reuse is rejected.

**Replay — PASS.** Covered above; wrong-token also proven no-spawn by
`confirm_with_wrong_token_reissues_and_does_not_spawn` (`:411-431`, asserts
`runner.call_count() == 0`).

### FINDING NET08-C — confirmation token compared with `==`, not constant-time

**Severity: LOW.**

**Location:** `crates/freshell-platform/src/elevated.rs:170` (and the same pattern at
`:194` in `consume_current_confirmation`).

```rust
(Some(c), Some(t)) => c.token == t && c.action == action,   // :170 — short-circuits
```

Rust's `str` equality short-circuits on the first differing byte, making this
timing-variable. This is a real inconsistency: the *auth* token is carefully compared
with `freshell_api::constant_time_eq` (`boot.rs:705`), and the confirmation token —
which authorizes an **elevated, post-UAC** operation — is not.

I am rating this LOW rather than higher, honestly: the token is a `randomUUID` (122 bits
of entropy), each failed guess **destroys and re-issues** the token via the
`Issued`/`Reissued` paths, and the remote timing signal across a network is far below the
per-byte delta. It is not practically exploitable. It is still the wrong primitive in a
security-critical comparison, it is a one-line fix, and leaving it invites the pattern to
be copied. Use `freshell_api::constant_time_eq` at both `:170` and `:194`.

### Consumption on the failure path — deviation from the brief, judged correct

The brief expects the token "consumed on both success and failure paths". The code does
**not** consume on mismatch: `consume_confirmation` returns `false` and leaves
`self.current` intact, and the caller then *overwrites* it with a fresh token via
`issue_confirmation` (`:243`, `:254`). The net effect is equivalent — the presented
token is invalidated either way, and no stale token survives a failed attempt — while
also preserving the reference's UX (the client immediately receives a usable new token).
I checked whether this enables an oracle: it does not, because the attacker's guess is
discarded regardless of outcome. **Not a finding**, but flagging the intentional
divergence so it is not mistaken for an oversight later.

---

## 5. CONCURRENCY — in-progress lock and TOCTOU

**Status: PASS for the current single-threaded `&mut self` design; MUST be re-audited
when shared across requests.**

I specifically looked for a TOCTOU window between the check and the set. There is none
*within* `try_acquire_repair_lock` (`elevated.rs:208-214`):

```rust
pub fn try_acquire_repair_lock(&mut self) -> bool {
    if self.repair_in_flight { return false; }
    self.repair_in_flight = true;
    true
}
```

Check and set are both under the same `&mut self` exclusive borrow, so Rust's borrow
checker guarantees no interleaving — this is atomic by construction, not by discipline.

The early-return pre-check at `:237-239` **is** a classic TOCTOU shape (read
`repair_in_flight`, act later), but it is correctly backstopped: the authoritative
acquisition at `:247-249` re-checks and returns `Locked` if the race was lost, and the
token is only consumed at `:252` **after** the lock is held. Ordering is right:
lock → consume → spawn. Lock release on the re-issue path (`:253`) prevents a
deadlock-by-abandoned-lock.

**Requirement for wiring (this is the part that will actually bite):** `&mut self`
means the gate must live behind a `Mutex`/`RwLock` in shared axum state. If a future
implementation takes the lock, drops the guard, and *then* calls `request_elevation`, the
`&mut`-derived atomicity is lost and two concurrent confirmed requests could both spawn
elevated commands. The guard must be held across the whole `request_elevation` call.
A `tokio::sync::Mutex<ConfirmationGate>` with the guard held for the duration is the
correct shape. I could not audit this because no wiring exists.

I also note the release path is not panic-safe: `request_elevation` releases the lock
manually at `:253` / `:261`. If `spawn_elevated_powershell` panics, the lock leaks and
every subsequent privileged op returns 409 forever (an availability bug, not a security
bypass). An RAII guard would be the idiomatic fix.

---

## 6. SECRET HYGIENE (NET-03) — auth token / share-URL token in logs

**Status: PASS for the live configuration. One conditional gap documented.**

The `accessUrl` in the status response embeds the live `AUTH_TOKEN`
(`network.rs:192` → `access_url`, `crates/freshell-platform/src/network.rs:245-260`).
That is by design — it is the shareable URL, delivered to an already-authenticated
caller over the response body. The question is whether it leaks into *logs*.

Three defenses, checked in order:

1. **Writer-level scrub (`logging.rs:181-201`), applied to every line before any byte
   reaches disk** (`RotatingWriter::write_line`, `:288-296`). It replaces the verbatim
   secret, then redacts any `"*token*"` JSON field, `"cookie"` fields, and raw
   `Cookie:`/`Set-Cookie:` headers. The design point — the scrub is a property of the
   writer, not of the call site — is the right architecture: no handler can leak by
   forgetting.
2. **Route sanitization (`logging.rs:460-479`)** strips `?token=` from the logged route
   before it reaches the formatter.
3. **Diag redaction (`diag.rs:193-214`, `is_secret_key` at `:218-228`)** redacts
   `token`/`apikey`/`secret`/`password`/`credential`/`cookie`/`authorization` keys at any
   depth, plus marker-tagged fields.

`crates/freshell-server/src/network.rs` emits **no log statements at all** (no
`tracing::`/`info!`/`debug!`), so `accessUrl` never reaches a logger from the network
module in the first place.

### INFO-2 — percent-encoding can defeat the verbatim-secret scrub (conditional, does not apply to this host)

**Severity: INFORMATIONAL.**

**Location:** `crates/freshell-server/src/logging.rs:184` interacting with
`crates/freshell-platform/src/network.rs:258`.

`scrub` replaces the secret **verbatim** (`out.replace(secret, ...)`), but `access_url`
writes the token **percent-encoded** (`encode_uri_component`, `network.rs:227-241`). If a
token contains any character outside `A-Za-z0-9-_.!~*'()`, the encoded form differs from
the raw form and the verbatim replace misses. The `"*token*"`-field regex does not
rescue it either, because `accessUrl` is not a token-named key — the secret sits inside
a **value** under a key named `accessUrl`.

I reproduced the two cases exactly:

```
token = "a b/c+tok"  -> logged: "accessUrl":"http://…/?token=a%20b%2Fc%2Btok"   [NOT redacted]
token = "6df03d3ed04…" -> logged: "accessUrl":"http://…/?token=***REDACTED***"  [redacted]
```

**Why this is informational and not a finding:** the live `AUTH_TOKEN` in `.env` is
64 hex characters (verified: `len=64`, `hex_only=1`). Hex is entirely within the
unreserved set, so encoding is the identity function and the verbatim scrub matches. The
Tauri-generated token is also hex (`crates/freshell-tauri/src/server.rs:164`). So there
is **no live leak**. The gap only opens if someone sets a token containing a reserved
character — and nothing enforces that they can't.

**Recommended hardening:** in `scrub`, also replace `encode_uri_component(secret)`
alongside the verbatim secret, and/or add `accessurl` to a URL-bearing key regex that
strips `token=` from values. Cheap, and it removes the dependency on an undocumented
invariant about token alphabets.

---

## 7. EXECUTION GUARD — Windows mutations structurally unreachable

**Status: PASS. This is the strongest control in the audited surface, and it is what
downgrades NET08-A/B from HIGH to MEDIUM/LOW.**

Three independent reasons a mutating Windows command cannot run on this host:

1. **No caller.** `spawn_elevated_powershell`, `request_elevation`,
   `build_port_forwarding_script`, `build_firewall_only_script`,
   `build_port_forwarding_teardown_script`, and all three
   `build_windows_firewall_*_commands` have **zero non-test callers** across `crates/`.
   The only non-test references are `pub use` re-exports (`lib.rs:68,81`). Verified by
   exhaustive grep per-symbol.
2. **No route.** Section 0 — nothing HTTP-reachable dispatches to them.
3. **No runner.** The only `StdCommandRunner` instantiation in the network path is
   `network.rs:228`, feeding `detect_firewall` + the LAN-IP probes. Every one of those is
   read-only (`netsh … show`, `ufw status`, `ipconfig.exe`, a fixed-string
   `powershell -NoProfile -NonInteractive -Command <const>`). Every mutating builder is
   exercised **only** through `FakeCommandRunner`.

Additionally, `StdCommandRunner::run` (`lib.rs:314-324`) uses `Command::new(cmd).args(...)`
with `stdin(Stdio::null())` — argv, never a shell — and a 5s kill-on-timeout, so even the
read-only probes cannot hang or be shell-injected.

`ConfirmationGate` is never constructed outside tests, so even the confirmation state
machine is inert.

---

## Findings summary

| ID | Severity | Location | Summary |
|---|---|---|---|
| NET08-A | **MEDIUM** (HIGH once wired) | `freshell-platform/src/port_forward.rs:338` | `wsl_ip` interpolated into the elevated PowerShell script with no validation; `;`-injection PoC confirmed. Unreachable today (no caller, no route). |
| NET08-B | **LOW** | `freshell-platform/src/port_forward.rs:338` | Newlines survive into the elevated script — second injection primitive, same root cause and fix as NET08-A. |
| NET08-C | **LOW** | `freshell-platform/src/elevated.rs:170`, `:194` | Confirmation token compared with short-circuiting `==` instead of `constant_time_eq`, inconsistent with the auth-token path. |
| INFO-1 | Info | `freshell-protocol/src/settings.rs` | No `deny_unknown_fields`; unknown keys silently dropped. Not exploitable; will not be inherited by new routes. |
| INFO-2 | Info | `freshell-server/src/logging.rs:184` | Verbatim-secret scrub misses percent-encoded tokens in `accessUrl`. No live leak — the live token is 64-char hex. |

**High/critical findings: 0.**

---

## Verdict and the caveat that matters

Zero high/critical findings **against the code that exists**. The auth gate is correctly
ordered and constant-time, hostile hosts are rejected by a closed enum, the PowerShell
quoting primitive is correct, the token gate is one-time and action-bound, the lock is
atomic by construction, and mutating Windows commands are unreachable three ways over.

But I want to be direct rather than reassuring: **this audit largely certifies absence.**
The four mutating routes named in the brief do not exist. The "PASS" on execution-guard,
concurrency-under-load, and command-construction-from-request-input all rest on
`there is no caller` — which is a real and effective control today, and evaporates the
moment the next slice lands.

Three things must happen before this surface faces an untrusted LAN:

1. **Fix NET08-A/B first, before wiring.** Change the builder signatures to take a
   validated `Ipv4Addr` newtype so unvalidated strings become a compile error. Fixing
   this while it is unreachable costs one refactor; fixing it after wiring is an
   incident.
2. **Fix NET08-C** (two-line change to `constant_time_eq`) so the pattern is not copied.
3. **Re-audit mandatorily** once `configure` / `disable-remote-access` /
   `configure-firewall` / `lan-info` exist — with specific attention to per-route auth
   ordering (prefer a middleware layer over four hand-written checks), the
   `Mutex<ConfirmationGate>` guard being held across the whole `request_elevation` call,
   and RAII lock release.

---

### Audit hygiene

- The PoC test file `crates/freshell-platform/tests/tmp_audit_poc.rs` was created,
  executed (4/4 passing, output quoted above), and **deleted**. `git status` shows no new
  tracked or untracked files beyond the pre-existing plan docs and this report.
- `cargo test -p freshell-platform` passes.
- No server was restarted; no build overwrote `dist/`. Live probes were read-only apart
  from the `PATCH /api/settings` input-validation probes disclosed in §2, whose final
  persisted state matches the pre-probe state.
