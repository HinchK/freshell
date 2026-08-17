# Terminal mode replay sync — plan

## Context

After any browser page load (hard refresh, new window, server-driven re-attach), a pane's xterm instance is recreated and rehydrated from the server's retained replay buffer. Applications like opencode (1.18.18), vim, and other TUI programs enable DEC private modes — mouse tracking (`CSI ? 1000/1002/1003 h`, SGR mouse format `? 1006 h`), alternate screen (`? 1049 h`), cursor visibility (`? 25 l`), bracketed paste (`? 2004 h`), focus tracking (`? 1004 h`) — **exactly once, at the very start of the process's life**. Those startup bytes scroll out of the retained replay window, so the freshly recreated xterm boots with default modes: **no mouse tracking**, normal (non-alt) screen, cursor visible, no bracketed paste.

Observable symptom proven live on 2026-08-16 against the production server: the full retained replay of a long-lived opencode pane (1.7 MB) contained **zero** mouse-enable sequences; a freshly spawned opencode emitted `?1000h ?1002h ?1003h ?1006h ?1049h ?2004h` in its first render burst (probe evidence preserved in the session investigation). The result: xterm.js never forwards wheel events to the app (`mouseTrackingMode === 'none'`), so mouse scroll does nothing, while keyboard PgUp/PgDn keep working (plain key input is always forwarded). Alt-screen mode lost alongside produces further corruption of scroll/selection behavior. A resize does not heal it — opencode does not re-emit mode-set sequences on SIGWINCH (probe-confirmed).

This is distinct from the geometry-stomp root cause fixed in PR #649 (verified fixed by its own acceptance tests); it is an orthogonal client-emulator state-restoration gap.

## Goal

Any attach that replays buffered output recreates the client's terminal-emulator private-mode state to match the application's current ground truth, as tracked by the server from the byte stream. Mouse scroll, wheel forwarding, alt-screen scroll/selection, cursor visibility, and bracketed paste behave identically whether the page was loaded before or after the app started.

## Design

**One rule:** the server is the architecture-of-record for the terminal's emulator mode state, because it sees every byte the application has ever emitted. On every attach, before streaming retained replay bytes to the attaching socket, the server emits a synthesized **mode preamble** — the set of `CSI ? Pm h` / `CSI ? Pm l` sequences representing the terminal's currently-tracked private-mode state. The client requires no changes: synthesized bytes travel the ordinary output path and are applied by xterm.js identically to application output.

### Components

**1. Mode tracker (per terminal, server-side).** A small stateful scanner that consumes every output chunk appended to the terminal's replay buffer (the existing single serialization choke point) and maintains a map `{ param: true|false }` of DEC private modes seen, by their latest set (`h`) or reset (`l`).

- Chunk-boundary safety: retain a short carry tail (64 bytes — longest realistic `CSI ? ...;...;... h` is far shorter) prepended to the next chunk before matching.
- Combined parameter lists: `CSI ? 1003;1006 h` applies to both params.
- Tracks ALL `?Pn` private-mode set/resets generically (no UX policy, no app-specific list). This fixes the whole mode family per-terminal (cursor visibility, focus reporting, etc.) and requires no per-mode decisions. Map is capped at 128 entries with oldest evicted (operator-facing debug log on eviction; realistically < 30).
- Lifecycle: tracker is per-terminal; it is created with the PTY and dropped on terminal exit/recreate.

**2. Attach preamble synthesis (both servers, parity).** On attach (all intents — `viewport_hydrate`, `keepalive_delta`, `transport_reconnect`; hidden or visible), compute the preamble from the terminal's tracker state and stream it as the socket's first output chunk, ordered before any replay slice. Synthesis from the tracker's map: set modes first (`h`), then resets (`l`); each mode emitted at most once; empty map → empty preamble (no cost). Idempotent: re-asserting a mode the client already holds is a no-op in xterm.js.

- Rust: preattach assembly point in `crates/freshell-ws/src/terminal.rs` `handle_attach` (where snapshot + tail are obtained from the registry); tracker owned by `crates/freshell-terminal` registry/broker output append path.
- Node: `server/terminal-stream/broker.ts` — same two integration points (output-append scan, per-socket attach preamble). Both implementations produce byte-identical preambles for identical tracked state.

**3. No client change.** Deliberate scope cut: the replay path is the injection point, so every attach (visible, hidden warm, reconnect, REST-driven) receives mode restoration exactly once, before content bytes.

### Non-goals

- No change to application programs (they are not required to re-emit).
- No server-side tracking of cursor position, scroll region, character sets, or graphics state (out of scope; only the reasonably-observable, replay-lost DEC private modes).
- No persisted mode state across server restart (post-restart PTYs are either dead or freshly spawned; full-spawn replay covers those cases; ledger-resumed panes respawn fresh PTYs whose startup bytes are always retained).

## Tasks

### Task 1 — Rust: mode tracker + attach preamble

TDD.

1. `crates/freshell-terminal/src/mode_tracker.rs` (new): the scanner. Unit tests: split-sequence across chunk boundary; combined param lists; set-then-reset and reset-then-set emit latest; non-tracked modes (non-`?` CSI) ignored; cap eviction; `preamble()` ordering and byte shape.
2. Wire tracker into the output-append path of the registry (fresh instance per terminal at spawn; dropped on exit).
3. `handle_attach`: stream preamble as first output bytes of the socket, before replay slice, for all intents.
4. ws integration test: spawn a scripted PTY that emits `?1003h`+`?1006h` once and then floods ≥ the configured replay cap with junk; attach a second socket with `sinceSeq: 0`; assert the socket's received stream contains `?1003h` and `?1006h` even though the literal retained replay tail does not.

### Task 2 — Node parity

Same tracker module + same two integration points in the Node server (`server/terminal-stream/`), same unit coverage, plus a broker attach test mirroring Task 1's scenario. Byte-shape parity assertion between the two preamble builders can be expressed in the existing port-contract tests if cheap.

### Task 3 — e2e: reload restores mouse + alt screen

Extension of `test/e2e-browser/specs/multi-client.spec.ts` (both matrix projects, Node + Rust legs):

1. Create a terminal pane running a small emitter script (prints `?1003h ?1006h ?1049h` once, then a heartbeat periodically — avoids provider flakiness).
2. Load page → pane attaches (emulator receives literal startup bytes).
3. Navigate/reload the page in place (same URL+token) → pane re-attach goes through the replay path only.
4. Assert via the page's e2e harness buffer/mode hooks: `term.modes.mouseTrackingMode === 'any'` and `term.buffer.active.type === 'alternate'` after re-attach, and NO `terminal.input` was written to produce state (i.e. the wire replay itself carried the modes).
5. End-to-end behavior evidence: synthesize a wheel-up event over the pane and assert a `terminal.input` message leaves the page containing the SGR wheel-up sequence (`\x1b[<64;...`).

### Task 4 — live verification

Same approach as PR #649 Task 3: scratch dev instance (setsid + pinned ports + owned process-group teardown), real opencode 1.18.18 pane on a long-lived session, hard refresh of the served page, then confirm: kernel-vs-viewport dims consistent && mouse scroll reaches opencode (scroll position changes; footer stable). Cleanup + full-suite gate + whole-branch review.

## Acceptance

- Task-3 e2e passes on both server implementations.
- Live opencode hard-refresh scroll regression no longer reproducible: mouse wheel works immediately after refresh on a pane whose app started long before page load.
- Full-suite gate: `npm run check` + `cargo test --workspace --exclude freshell-tauri` green modulo the ledger's pre-existing flakes (katas jgpc, ep0f, xqfc).

## Risks / open questions (for load-bearing validation)

- C1: PTY output flows through exactly one append path per server where the scanner can be attached without missing direct-to-socket writes.
- C2: The attach path streams replay strictly per-socket from one assembly point in each server, so a per-socket preamble is insertable without side effects on other attached sockets.
- C3: xterm.js applies synthesized `?1003h`-family output bytes identically to app-emitted bytes (parser-level mode application, including `modes.mouseTrackingMode` observable state used by the wheel path).
- C4: Emitting mode set/reset sequences NOT in the literal replay tail is safe for all clients (no protocol layer sanitizes/drops them; no client treats output-before-attach-ready specially in a way that would lose it).
- C5: Owner of the replay bytes sees them in the same order as the preamble: preamble strictly before replay content; no interleave with live-streamed app output during attach (or interleave is harmless/order-stable).
- C6: Tracker-on-full-output cost is negligible (bounded regex on small strings at already-serialized choke point) — validate by measuring the instrumentation point's existing hot path.
- C7: Node parity choke point exists and is genuinely symmetrical to the Rust one (line-level proof, not convention).
- C8: The earlier symptom chain attribution holds: post-refresh wheel events reach xterm, xterm with `mouseTrackingMode === 'none'` sends nothing to the PTY (vs. scrolling local backscroll), PgUp/PgDn remain key input — hence the exact user-reported symptom split.
