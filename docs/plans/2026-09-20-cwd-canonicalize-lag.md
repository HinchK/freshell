# cwd-canonicalize-lag Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Stop the FRESHELL host-stats tile from toggling `lagging` on/off in production: eliminate the 0.4–2s async-runtime stalls caused by uncached, eager on-disk cwd resolution (`std::fs::canonicalize`) of session working directories on WSL2 9P-mounted paths (Google-Drive-backed `/mnt/d`) in the sessions→terminal identity lookup path (`find_all_by_session`, used by the 5s auto-title sweep), by making cwd normalization lazy (claude-scoped only) and memoized (resolve once per distinct cwd per registry).

### Explicit constraints
- Run the fix through the the-usual workflow: dedicated worktree under `.worktrees/`, TDD red/green/refactor with unit and e2e-level coverage, independent Fresh Eyes reviews, and a PR targeting `main` (branch prepared and pushed, but no PR created without explicit user approval).
- Preserve the cwd-scoped claude session→terminal matching contract from `find_all_by_session` (claude-only scoping, session-cwd/terminal-cwd equality after normalization, absent-session-cwd skips the check, terminal-without-cwd excluded) and the normalize semantics (canonicalize with lexical fallback, backslash→slash, trailing-slash strip, Windows lowercase).
- Keep Node-parity semantics in mind: `normalize_scoped_cwd` ports `normalizeScopedSessionCwd` (terminal-registry.ts:414-431); the port's per-call `realpath` eager resolution is the same landmine — the memoization is a deliberate, documented performance divergence.
- Never restart/deploy the production self-hosted server (port 3001) without the user's explicit "APPROVED"; landing the fix on `main` does not deploy it.
- The user waived the green-base requirement on 2026-09-20: the freshagent kill/handoff fencing family red at main (kata b46d) is an enumerated pre-existing failure; proceed on red with clean attribution (this run never touches freshell-freshagent).

### Accepted tradeoffs and residuals
- Memoized resolution may serve a stale canonical path if a cwd's symlink target changes after first resolution (accepted; both comparison sides use the same per-registry memo, so matching stays internally consistent).
- The first canonicalize of a never-before-seen claude cwd may still stall the async runtime once per registry lifetime; the lazy fix removes non-claude stalls entirely.
- Other uncached canonicalize sites (`opencode_locator::normalize_cwd` at arm-time (inline-async at create, blocking pool on ticks), `repo_icon`, `amplifier_stub::ensure_session`, `terminal.rs` replay-cwd check) are out of scope; they are per-event/client-driven, not per-sweep, and do not cause the observed tile toggling.
- The fix is not live in production until the user separately approves a server deploy.
- Full-suite gates during this run are green-except-the-kata-b46d-family.

**Goal:** Eliminate the per-session, per-sweep on-disk cwd resolution in the session→terminal identity lookup so the FRESHELL host-stats tile stops flipping to `lagging` every ~5s during active agent workloads on 9P-mounted project directories.

**Architecture:** The fix is confined to `TerminalIdentityRegistry` (crates/freshell-ws/src/identity.rs). The registry gains a per-instance cwd-normalization memo (`Arc<Mutex<HashMap<String, String>>>`, shared across clones like the existing `inner` map). `find_all_by_session` becomes lazy — it computes the session's normalized cwd only when the provider is claude-scoped — and routes both session-side and terminal-side normalization through the memo, so each distinct raw cwd string is resolved on disk exactly once per registry lifetime instead of once per session per ~5s sweep pass. The core `normalize_scoped_cwd` (canonicalize with lexical fallback + backslash/trailing-slash/Windows normalization) is unchanged; it just moves behind the memo. Matching semantics are preserved exactly; the delta is when filesystem resolution happens and how often.

**Tech Stack:** Rust (tokio async runtime, `std::sync` locks), Cargo tests with `tempfile` + `#[cfg(unix)]` symlinks, Vitest/Playwright unaffected, Playwright cloud e2e specs for end-state verification.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/cwd-canonicalize-lag` on branch `the-usual/cwd-canonicalize-lag` (base_ref `855dae72a83404c930a56d8c6810dab5746720fa`). Never commit to `main` directly.
- No PR creation without explicit user approval. Commit identity comes from the repo/global git config (Dan Shapiro <3732858+danshapiro@users.noreply.github.com>); never override it.
- Never restart/deploy the production server on port 3001 (requires the user's word "APPROVED").
- The base is red ONLY in kata b46d (5 freshagent fencing tests, user-waived 2026-09-20). Gate pass criterion for this run: green excluding that enumerated family. This change never touches `crates/freshell-freshagent`.
- Narrowed cargo selectors are delegated (no coordinator wait); broad zero-arg lanes (`npm test`, `test:server`, `test:integration`) wait for the shared coordinator gate (`npm run test:status` first; wait rather than kill a foreign holder).
- `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud` are the configured backends (set in `~/.bashrc`); never silently fall back to local.
- Tests needing symlinks use `std::os::unix::fs::symlink` behind `#[cfg(unix)]` (repo precedent: `crates/freshell-server/src/repo_icon.rs:536-554`). `tempfile` is already a dev-dependency of both touched crates — no Cargo.toml changes.
- Rust code follows repo conventions: doc comments stating contracts and Node-parity references, `expect("...")` messages on locks, snake_case contract-stating test names, sorted `Vec<String>` comparisons for multi-match assertions.
- Pre-push gate (Rust-only push) runs `cargo fmt --all --check`, workspace clippy `-D warnings` (excluding freshell-tauri), then targeted `cargo test --locked -p freshell-server -p freshell-ws` — none of which include the b46d family (freshagent), so pushes are unaffected by the waived red.

---

### Task 1: Per-registry cwd normalization memo in `TerminalIdentityRegistry`

**Files:**
- Modify: `crates/freshell-ws/src/identity.rs` (registry struct ~:88-96, new method + test accessor near the other lookups, tests module at :374+)

**Interfaces:**
- Consumes: existing private free function `normalize_scoped_cwd(cwd: &str) -> String` (identity.rs:359).
- Produces: `TerminalIdentityRegistry` field `cwd_memo: Arc<std::sync::Mutex<HashMap<String, String>>>` (derive-compatible with the existing `Clone, Debug, Default` — all ~122 constructions across 50 files go through `::new()`/`Default`, zero struct literals, zero serde, so adding the field is non-breaking); `pub(crate) fn normalize_scoped_cwd_cached(&self, cwd: &str) -> String`; `#[cfg(test)] pub(crate) fn cwd_memo_len_for_tests(&self) -> usize` (precedent: `activity.rs:618-626` `_for_tests` cfg-gated accessor).

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)] mod tests` in `crates/freshell-ws/src/identity.rs`:

```rust
#[test]
#[cfg(unix)]
fn memoized_cwd_resolution_resolves_a_symlink_once_then_serves_retargets_from_the_memo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let real_a = dir.path().join("a");
    let real_b = dir.path().join("b");
    std::fs::create_dir_all(&real_a).expect("mkdir a");
    std::fs::create_dir_all(&real_b).expect("mkdir b");
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real_a, &link).expect("symlink");
    let link_str = link.to_str().expect("utf8 path").to_string();

    let reg = TerminalIdentityRegistry::new();
    let first = reg.normalize_scoped_cwd_cached(&link_str);
    assert_eq!(first, real_a.to_str().expect("utf8 path"));

    // Retarget the symlink: the memo deliberately serves the FIRST
    // resolution (the accepted tradeoff). Both matching sides share the
    // same memo, so cwd-scoped matching stays internally consistent.
    std::fs::remove_file(&link).expect("unlink");
    std::os::unix::fs::symlink(&real_b, &link).expect("retarget symlink");
    let second = reg.normalize_scoped_cwd_cached(&link_str);
    assert_eq!(second, first, "memoized resolution must be stable across retargets");
    assert_eq!(reg.cwd_memo_len_for_tests(), 1);
}

#[test]
fn memoized_cwd_resolution_memoizes_the_lexical_fallback_for_missing_paths() {
    let reg = TerminalIdentityRegistry::new();
    let first = reg.normalize_scoped_cwd_cached("/definitely/not/here/");
    assert_eq!(first, "/definitely/not/here"); // lexical fallback + trailing slash strip
    let second = reg.normalize_scoped_cwd_cached("/definitely/not/here/");
    assert_eq!(second, first);
    assert_eq!(reg.cwd_memo_len_for_tests(), 1);
}

#[test]
fn memoized_cwd_resolution_is_shared_across_registry_clones() {
    let reg = TerminalIdentityRegistry::new();
    reg.normalize_scoped_cwd_cached("/x");
    let clone = reg.clone();
    assert_eq!(clone.cwd_memo_len_for_tests(), 1);
    clone.normalize_scoped_cwd_cached("/x");
    assert_eq!(reg.cwd_memo_len_for_tests(), 1);
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --lib --locked -- memoized_cwd_resolution`

Expected: FAIL to compile — `normalize_scoped_cwd_cached` and `cwd_memo_len_for_tests` do not exist on `TerminalIdentityRegistry` (the new seam for the missing behavior; the three tests then go green the moment the seam is implemented, and the retarget test locks the accepted tradeoff as a contract).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/identity.rs`:

1. Extend the import: `use std::sync::{Arc, Mutex, RwLock};`
2. Add the field to the registry struct:

```rust
#[derive(Clone, Debug, Default)]
pub struct TerminalIdentityRegistry {
    inner: Arc<RwLock<HashMap<String, TerminalIdentity>>>,
    /// Per-registry memo: raw cwd string -> normalized cwd string
    /// (`normalize_scoped_cwd`). Shared across clones like `inner`, so one
    /// registry instance (the process-wide `WsState` clone family) resolves
    /// each distinct cwd on disk ONCE instead of once per session per ~5s
    /// auto-title sweep pass — eager per-call canonicalization stalled the
    /// async runtime 0.4-2s per resolution on WSL2 9P-mounted,
    /// cloud-sync-backed cwds (the FRESHELL host-stats `lagging` toggle root
    /// cause). Deliberately unbounded: keyed by distinct cwd strings, which
    /// a machine produces at most in the hundreds. Values are stable per
    /// key: a symlink retarget after first resolution keeps serving the
    /// first target (accepted tradeoff; both comparison sides share this
    /// memo, so matching stays internally consistent).
    cwd_memo: Arc<Mutex<HashMap<String, String>>>,
}
```

3. Add the method and test accessor next to the other lookups:

```rust
/// [`normalize_scoped_cwd`] behind the per-registry memo: the first lookup
/// of a raw cwd pays the on-disk canonicalize; every later lookup of the
/// same raw string returns the memoized normalized value without touching
/// the filesystem. Lock discipline: the filesystem resolution happens
/// OUTSIDE the lock, so a slow path (9P stall) never holds the memo lock.
pub(crate) fn normalize_scoped_cwd_cached(&self, cwd: &str) -> String {
    if let Some(hit) = self
        .cwd_memo
        .lock()
        .expect("cwd memo lock poisoned")
        .get(cwd)
    {
        return hit.clone();
    }
    let normalized = normalize_scoped_cwd(cwd);
    self.cwd_memo
        .lock()
        .expect("cwd memo lock poisoned")
        .insert(cwd.to_string(), normalized.clone());
    normalized
}

#[cfg(test)]
pub(crate) fn cwd_memo_len_for_tests(&self) -> usize {
    self.cwd_memo.lock().expect("cwd memo lock poisoned").len()
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --lib --locked -- memoized_cwd_resolution`

Expected: PASS (3 tests).

- [ ] **Step 5: Refactor while green**

None needed beyond what Step 3 wrote: the method is single-purpose, the memo is one field, no duplication.

- [ ] **Step 6: Run impacted-test verification**

The registry struct changed: every in-crate test constructs it (all still compile via `Default`), and nothing else consumes the new members. Run the full freshell-ws lib suite plus the dependent crate's lib suite:

Run: `cargo test -p freshell-ws --lib --locked && cargo test -p freshell-server --lib --locked -- auto_title`

Expected: PASS. (The dependent-crate full lib suite runs again in Task 3's Step 6; here the auto_title slice is the consumer of the registry.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/identity.rs
git commit -m "feat(ws): per-registry cwd normalization memo for the identity lookup"
```

---

### Task 2: Lazy claude-scoped session cwd, memo-routed matching

**Files:**
- Modify: `crates/freshell-ws/src/identity.rs:311-372` (`find_all_by_session` + the `normalize_scoped_cwd` doc comment)

**Interfaces:**
- Consumes: `normalize_scoped_cwd_cached` from Task 1.
- Produces: unchanged public signature `find_all_by_session(&self, provider: &str, session_id: &str, cwd: Option<&str>) -> Vec<TerminalIdentity>` with identical matching semantics; only the resolution schedule changes (lazy + memoized).

- [ ] **Step 1: Write the failing behavioral tests**

Add to the `#[cfg(test)] mod tests`:

```rust
#[test]
#[cfg(unix)]
fn find_all_by_session_canonicalizes_through_real_symlinks_for_claude() {
    let dir = tempfile::tempdir().expect("tempdir");
    let real = dir.path().join("real");
    std::fs::create_dir_all(&real).expect("mkdir");
    let session_link = dir.path().join("session-link");
    let terminal_link = dir.path().join("terminal-link");
    std::os::unix::fs::symlink(&real, &session_link).expect("symlink s");
    std::os::unix::fs::symlink(&real, &terminal_link).expect("symlink t");

    let reg = TerminalIdentityRegistry::new();
    reg.upsert(
        "t1",
        Some("claude"),
        Some("s1"),
        Some(terminal_link.to_str().expect("utf8")),
        1,
    );

    let matched = reg.find_all_by_session(
        "claude",
        "s1",
        Some(session_link.to_str().expect("utf8")),
    );
    let ids: Vec<String> = matched.into_iter().map(|t| t.terminal_id).collect();
    assert_eq!(ids, vec!["t1".to_string()]);
    // Both sides resolved exactly once, THROUGH the memo: with the eager
    // per-call canonicalize this is 0 (the pre-fix red).
    assert_eq!(reg.cwd_memo_len_for_tests(), 2);
}

#[test]
fn find_all_by_session_leaves_the_memo_untouched_for_non_scoped_providers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let real = dir.path().join("real");
    std::fs::create_dir_all(&real).expect("mkdir");
    let real_str = real.to_str().expect("utf8");

    let reg = TerminalIdentityRegistry::new();
    reg.upsert("t1", Some("codex"), Some("s1"), Some(real_str), 1);

    let matched = reg.find_all_by_session("codex", "s1", Some(real_str));
    assert_eq!(
        matched.into_iter().map(|t| t.terminal_id).collect::<Vec<_>>(),
        vec!["t1".to_string()]
    );
    // The pre-fix code eagerly canonicalized EVERY session's cwd for every
    // provider; the lazy fix must never resolve cwd on disk for non-claude
    // lookups (the /mnt/d stall class this change exists to kill).
    assert_eq!(reg.cwd_memo_len_for_tests(), 0);
}

#[test]
fn find_all_by_session_treats_an_empty_session_cwd_as_absent_for_scoping() {
    // Pin the previously-unpinned empty-string clause: "" must skip the
    // cwd check exactly like `None`, with no on-disk resolution either.
    let reg = TerminalIdentityRegistry::new();
    reg.upsert("t1", Some("claude"), Some("s1"), Some("/a"), 1);
    reg.upsert("t2", Some("claude"), Some("s1"), None, 2);
    let mut ids: Vec<String> = reg
        .find_all_by_session("claude", "s1", Some(""))
        .into_iter()
        .map(|t| t.terminal_id)
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
    assert_eq!(reg.cwd_memo_len_for_tests(), 0);
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --lib --locked -- find_all_by_session`

Expected: the first test FAILS at `assert_eq!(reg.cwd_memo_len_for_tests(), 2)` — the eager code canonicalizes both sides through the uncached free function, so the memo is empty (the missing memo-routed behavior, not a setup accident). The other two tests pass (they pin preserved behavior; their discriminating power is regression-side).

- [ ] **Step 3: Add the minimal production implementation**

Replace `find_all_by_session` (identity.rs:311-341) with:

```rust
pub fn find_all_by_session(
    &self,
    provider: &str,
    session_id: &str,
    cwd: Option<&str>,
) -> Vec<TerminalIdentity> {
    // isCwdScopedSessionMode (terminal-registry.ts:410-412): claude only.
    let scoped = provider == "claude";
    // LAZY resolution: only claude-scoped lookups ever normalize the
    // session cwd. The eager form resolved EVERY session's cwd for every
    // provider on every ~5s sweep pass; on WSL2 9P-mounted,
    // cloud-sync-backed cwds each resolution stalled the async runtime
    // 0.4-2s (the FRESHELL host-stats `lagging` toggle root cause).
    // Non-scoped lookups never read the value, so they now pay nothing.
    let session_cwd = match (scoped, cwd) {
        (true, Some(c)) if !c.is_empty() => Some(self.normalize_scoped_cwd_cached(c)),
        _ => None,
    };
    self.list()
        .into_iter()
        .filter(|t| {
            if t.provider.as_deref() != Some(provider)
                || t.session_id.as_deref() != Some(session_id)
            {
                return false;
            }
            if !scoped {
                return true;
            }
            match &session_cwd {
                None => true, // absent session cwd -> cwd check skipped
                Some(want) => t
                    .cwd
                    .as_deref()
                    .map(|c| self.normalize_scoped_cwd_cached(c))
                    .is_some_and(|have| have == *want), // no terminal cwd -> excluded
            }
        })
        .collect()
}
```

And extend the `normalize_scoped_cwd` doc comment (identity.rs:356-358) with the divergence note:

```rust
/// `normalizeScopedSessionCwd` (terminal-registry.ts:414-431): realpath
/// (native preferred, lexical fallback on error) -> backslashes to `/` ->
/// strip trailing slashes -> lowercase on win32.
///
/// Deliberate divergence from the Node original: callers route through
/// [`TerminalIdentityRegistry::normalize_scoped_cwd_cached`], which resolves
/// each distinct raw cwd ONCE per registry lifetime instead of on every
/// lookup. The Node code's per-call realpath is the same 9P-stall landmine
/// this memo exists to fix; matching semantics are unchanged.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --lib --locked -- find_all_by_session`

Expected: PASS (4 tests, including the pre-existing `find_all_by_session_scopes_claude_by_normalized_cwd_and_skips_retired` contract test unchanged — it pins the lexical-fallback regime and must stay green).

- [ ] **Step 5: Refactor while green**

The `(scoped, cwd)` match replaces the old `cwd.filter(...).map(normalize_scoped_cwd)` eager form; the closure's `.map(|c| self.normalize_scoped_cwd_cached(c))` is the only terminal-side change. Nothing further to consolidate.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole freshell-ws lib (registry semantics), the dependent freshell-server lib (both `find_all_by_session` callers live in `run_auto_title_pass`), plus freshell-terminal's `SessionIdentityLookup` consumer pin (identity.rs:349 routes through `find_by_session`, cwd-blind, but runs in the same suite).

Run: `cargo test -p freshell-ws --lib --locked && cargo test -p freshell-terminal --lib --locked && cargo test -p freshell-server --lib --locked`

Expected: PASS for freshell-ws and freshell-terminal. For freshell-server: PASS, OR failures exactly and only inside the kata-b46d family — freshell-server's lib must be b46d-free; the b46d family lives in freshell-freshagent only. If ANY freshell-server failure appears, stop and investigate (it cannot be b46d).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/identity.rs
git commit -m "fix(ws): make find_all_by_session session-cwd resolution claude-lazy and memo-routed"
```

---

### Task 3: Sweep-level integration tests through `run_auto_title_pass`

**Files:**
- Test: `crates/freshell-server/src/auto_title_sweep.rs` (tests module, after the existing `sweep_state`/`session`/`spawn_headless_terminal_for_test` helpers at :587-659)

**Interfaces:**
- Consumes: `sweep_state(dir, ai_key) -> (AutoTitleSweepState, broadcast::Receiver<String>)`; `session(provider, id, cwd, first) -> SweepSession`; `spawn_headless_terminal_for_test(&registry, tid)`; `state.identity.upsert(...)`; `run_auto_title_pass(&state, &[...]) -> bool`; `#[tokio::test]` async pattern (:721-745).
- Produces: no production code. Three integration tests closing the coverage gaps the explorers identified: real-symlink matching through the full pass, the two-terminal cwd discriminator (currently zero coverage above unit level), and non-claude cwd-blindness through the sweep.

- [ ] **Step 1: Write the failing behavioral test**

The discriminator test is the red driver: today every claude sweep test uses *matching* cwds, so nothing would catch a cwd-discriminator regression. Add:

```rust
#[cfg(unix)]
#[tokio::test]
async fn sweep_cwd_discriminates_between_two_live_claude_terminals() {
    let dir = tempfile::tempdir().unwrap();
    let cwd_a = dir.path().join("a");
    let cwd_b = dir.path().join("b");
    std::fs::create_dir_all(&cwd_a).unwrap();
    std::fs::create_dir_all(&cwd_b).unwrap();
    let (state, mut rx) = sweep_state(dir.path(), None);

    spawn_headless_terminal_for_test(&state.registry, "t-a");
    spawn_headless_terminal_for_test(&state.registry, "t-b");
    state
        .identity
        .upsert("t-a", Some("claude"), Some("s1"), Some(cwd_a.to_str().unwrap()), 1);
    state
        .identity
        .upsert("t-b", Some("claude"), Some("s1"), Some(cwd_b.to_str().unwrap()), 2);

    // The session's cwd is cwd_a: only t-a matches, so the title push and
    // meta refresh must touch t-a only — never t-b.
    let changed =
        run_auto_title_pass(&state, &[session("claude", "s1", cwd_a.to_str().unwrap(), Some("hi"))])
            .await;
    assert!(changed);
    let mut saw_a = false;
    let mut saw_b = false;
    while let Ok(frame) = rx.try_recv() {
        if frame.contains("t-a") {
            saw_a = true;
        }
        if frame.contains("t-b") {
            saw_b = true;
        }
    }
    assert!(saw_a, "the cwd-matched terminal must receive the title push");
    assert!(!saw_b, "the cwd-mismatched terminal must never receive it");
}
```

- [ ] **Step 2: Run the test and verify its discriminating power**

Run: `cargo test -p freshell-server --lib --locked -- sweep_cwd_discriminates`

Expected: PASS at base — the matching semantics are correct today. This task adds coverage pins, not a behavior change (the behavior change was proven red→green in Task 2); these tests are regression guards whose red moment is exactly the regression they guard (a discriminator failure, a symlink-match failure, or an accidental scoping of codex). To verify the discriminator test can actually fail, temporarily change the session fixture's cwd to `cwd_b` in a scratch run and confirm the `saw_b` assertion fires; revert immediately. If the test unexpectedly fails WITHOUT any such perturbation, stop: the matching contract is broken in a way this plan must account for.

- [ ] **Step 3: Add the remaining tests**

```rust
#[cfg(unix)]
#[tokio::test]
async fn sweep_matches_a_claude_terminal_through_real_symlinked_cwds() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    std::fs::create_dir_all(&real).unwrap();
    let session_link = dir.path().join("session-link");
    let terminal_link = dir.path().join("terminal-link");
    std::os::unix::fs::symlink(&real, &session_link).unwrap();
    std::os::unix::fs::symlink(&real, &terminal_link).unwrap();
    let (state, mut rx) = sweep_state(dir.path(), None);

    let tid = "t-sym";
    spawn_headless_terminal_for_test(&state.registry, tid);
    state.identity.upsert(
        tid,
        Some("claude"),
        Some("s1"),
        Some(terminal_link.to_str().unwrap()),
        1,
    );

    // Different raw strings, same canonical directory: the pass must match
    // through REAL canonicalization (not the lexical fallback every existing
    // sweep test exercises) and push the title to the terminal.
    let changed = run_auto_title_pass(
        &state,
        &[session("claude", "s1", session_link.to_str().unwrap(), Some("hi"))],
    )
    .await;
    assert!(changed);
    let mut saw_push = false;
    while let Ok(frame) = rx.try_recv() {
        if frame.contains(tid) {
            saw_push = true;
        }
    }
    assert!(saw_push);

    // Second pass: the memoized resolution keeps the match stable, and the
    // already-persisted title means no further change is reported.
    let changed_again = run_auto_title_pass(
        &state,
        &[session("claude", "s1", session_link.to_str().unwrap(), Some("hi"))],
    )
    .await;
    assert!(!changed_again, "memo-stable match must not rewrite the title");
}

#[tokio::test]
async fn sweep_stays_cwd_blind_for_codex_sessions_with_real_cwds() {
    let dir = tempfile::tempdir().unwrap();
    let cwd_session = dir.path().join("a");
    let cwd_terminal = dir.path().join("b");
    std::fs::create_dir_all(&cwd_session).unwrap();
    std::fs::create_dir_all(&cwd_terminal).unwrap();
    let (state, mut rx) = sweep_state(dir.path(), None);

    let tid = "t-codex";
    spawn_headless_terminal_for_test(&state.registry, tid);
    state.identity.upsert(
        tid,
        Some("codex"),
        Some("s1"),
        Some(cwd_terminal.to_str().unwrap()),
        1,
    );

    // Different real cwds, same provider+session: codex matching must stay
    // cwd-blind (the lazy fix must never accidentally scope it) and the
    // first message must still drive the title push through the pass.
    let changed = run_auto_title_pass(
        &state,
        &[session("codex", "s1", cwd_session.to_str().unwrap(), Some("hi"))],
    )
    .await;
    assert!(changed);
    let mut saw_push = false;
    while let Ok(frame) = rx.try_recv() {
        if frame.contains(tid) {
            saw_push = true;
        }
    }
    assert!(saw_push);
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server --lib --locked -- sweep_`

Expected: PASS (the three new tests plus all existing `sweep_*` tests).

- [ ] **Step 5: Refactor while green**

The three tests share a drain-broadcast helper shape; if a fourth appears, extract `saw_terminal_in_broadcasts(&mut rx, tid) -> bool`. With three, keep them inline (no premature abstraction).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the full freshell-server lib (the auto-title module and every suite that constructs the registry through `AutoTitleSweepState`), plus the touched crates' suites.

Run: `cargo test -p freshell-ws --lib --locked && cargo test -p freshell-server --lib --locked`

Expected: PASS (freshell-server's lib contains none of the b46d family; any failure here is this run's to fix).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/auto_title_sweep.rs
git commit -m "test(server): pin sweep-level claude cwd matching through real symlinks"
```

---

### Task 4: End-state verification on the configured backends

**Files:**
- No source files. Verification-only task; no commit unless a verification failure requires a fix (any such fix is its own focused commit).

**Interfaces:**
- Consumes: all prior tasks' committed state.
- Produces: recorded evidence that the affected Rust lanes and the cloud-legal e2e specs pass on the configured backends (`FRESHELL_VITEST_BACKEND=cloud`, `FRESHELL_E2E_BACKEND=cloud`).

- [ ] **Step 1: Run the pre-push-equivalent cheap checks**

Run: `cargo fmt --all --check && cargo clippy --workspace --exclude freshell-tauri --all-targets --locked -- -D warnings`

Expected: PASS (no output from fmt; clippy exit 0).

- [ ] **Step 2: Run the targeted cargo test lane (pre-push gate parity)**

Run: `cargo test --locked -p freshell-server -p freshell-ws`

Expected: PASS (excludes the b46d family by construction).

- [ ] **Step 3: Run the affected cloud-legal Playwright specs**

Per the repo rule ("before filing any PR, ensure the affected e2e specs actually pass on the configured backend"): first check `CLOUD_SKIP_SPECS` in `test/e2e-browser/playwright.cloud.config.ts` — any of the four specs listed there is NOT cloud coverage; record which specs actually ran. Then run the four specs on the cloud e2e backend:

Run: `npm run test:e2e:cloud -- test/e2e-browser/specs/auto-title-rust.spec.ts test/e2e-browser/specs/title-sync-convergence.spec.ts test/e2e-browser/specs/pane-title-folds-rust.spec.ts test/e2e-browser/specs/session-directory-matrix.spec.ts`

If the cloud wrapper rejects positional spec filters, use the repo's documented e2e:cloud spec selection (inspect `scripts/e2e-cloud.sh`) and record the exact command used. If any spec file name differs at execution time, locate the real file under `test/e2e-browser/` and adjust.

Expected: PASS for every spec that actually ran — the auto-title e2e net proves a claude resume with a real cwd still converges the title/pane-header through `find_all_by_session`.

- [ ] **Step 4: Run the coordinated full suite (branch gate)**

This is the whole-branch gate for stage completion; it goes through the shared coordinator gate (check `npm run test:status` first; wait for any foreign holder).

Run: `FRESHELL_TEST_SUMMARY="the-usual cwd-canonicalize-lag branch gate" npm test`

Expected: green in every lane EXCEPT the enumerated kata-b46d family in the rust lane (4-5 freshagent fencing failures, waived by the user 2026-09-20 and recorded in the run-state baseline ledger). Any OTHER failure is this run's to fix before proceeding.

- [ ] **Step 5: Record evidence**

Record each command, exit status, and the b46d-family delta in the run-state progress ledger (paths under `.worktrees/.the-usual-logs/cwd-canonicalize-lag/`). No commit needed for the record (logs live outside the tracked tree).

---

## Plan-level verification summary

- Unit (Task 1): memo resolution-once, retarget-stability (the accepted tradeoff, made an explicit contract), fallback memoization, clone-sharing.
- Unit (Task 2): real-symlink matching through the memo (red→green), non-claude no-resolution, empty-cwd-as-absent, plus the untouched pre-existing contract test.
- Integration (Task 3): the full `run_auto_title_pass` path — discriminator between two live claude terminals (the previously-uncovered case), real-symlink match with cross-pass memo stability, codex cwd-blindness.
- E2E (Task 4): cloud-legal Playwright specs (`auto-title-rust.spec.ts` and siblings) on the configured cloud backend, plus the coordinated full-suite branch gate (green-except-b46d).

## Out of scope (documented residuals)

- `opencode_locator::normalize_cwd` (arm-time inline-async at create; ticks on the blocking pool), `repo_icon` canonicalizes, `amplifier_stub::ensure_session`, `terminal.rs:2388` replay-cwd check: per-event/client-driven sites, not per-sweep; excluded by the User Request.
- No Playwright spec is added for the lagging-tile stall itself (unassertable in CI); the in-crate integration tests are the practical e2e level for this server-internal behavior, consistent with repo precedent.
- Deploy: landing on `main` does not restart the production server; the user deploys separately with "APPROVED".
