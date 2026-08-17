# Terminal mode replay sync — plan (v2, load-bearing validated)

## Context

After any browser page load (hard refresh, new window, re-attach), a pane's xterm instance is recreated and rehydrated from the server's retained replay buffer. Applications like opencode (1.18.18), vim, and tmux enable DEC private modes — mouse tracking (`?1000/?1002/?1003h`, SGR mouse format `?1006h`), alternate screen (`?1049h`), cursor visibility (`?25l`), bracketed paste (`?2004h`), focus reporting (`?1004h`), and XTMODIFYKEYS (`CSI >4;1m`) — **exactly once, at process startup**. Those startup bytes scroll out of the retained replay window, so a recreated xterm boots with default modes: no mouse tracking, normal buffer, no bracketed paste. Proven live 2026-08-16: this pane's replay (1.7 MB tail) contained zero mouse sequences; the result is mouse wheel input never forwarded (xterm `mouseTrackingMode === 'none'`), PgUp/PgDn unaffected (plain key input). Distinct from the geometry-stomp root cause fixed in PR #649.

## Load-bearing validation (all rows closed)

- G1a client gates: prepend-into-first-replay-frame is the ONLY valid zero-envelope-change encoding; batch self-consistency fields must be recomputed; seq is frame-ordinal. Dead ends proven for seq-less frames and same-window duplicates. Constraint: preamble byte members must avoid codex startup-probe step bytes (`?2004h`, `?1004h`, `?6n`…) or probe parsing disarms — mitigated structurally by emitting the preamble before probe-containing regions only when the tracker knows those modes SET (then the app's own probe chain ran at spawn, long since out of the tail).
- G1b choke points (both servers confirm): Node = `TerminalStreamBroker.appendOutputFrames` (broker.ts:804) / `ReplayRing.append` (replay-ring.ts:62, already hosts `barrierScanner`); Rust = `registry.rs ingest` (registry.rs:2595, already hosts `s.scanner`). Preamble per-socket, reconstruct-on-copy (Node `replaySince` frames are shared ring references); never appended to the shared ring.
- G2 xterm-6.0.0 slot semantics: protocol family {9,1000,1002,1003} shares ONE `_activeProtocol` slot, last-write-wins on set, unconditional family-clear on reset of ANY member; encoding {1006,1016} identical shape. → tracker models FAMILY SLOTS, not per-param booleans. RIS resets everything except cursor-hidden 25; DECSTR resets a broad set but NOT mouse; C1 wire form is UTF-8 `C2 9B`; DECRQM queries never mutate (h/l finals only).
- G3 real app traffic (byte-faithful PTY captures with corrupted-C1 fix): zero RIS/DECSTR/C1 from opencode 1.18.18, vim 9.1, tmux 3.4 startup+teardown. Real non-h/l emission that IS lost on replay: XTMODIFYKEYS `CSI >4;1m` (opencode, vim), DECSCUSR shapes. tmux emits mode 7727 (inline-images). DECRQM only from opencode (6 queries).
- G4 gating: wire-only predicate falsified both directions (pane refresh / load-more-history / quarantine-repair / multi-client all send sinceSeq=0 onto preserved xterm surfaces; RIS/user-reset case can attach sinceSeq>0 onto a fresh surface). xterm hazard table: `?1004h` fires fake focus-report keypress into the app (unconditional); `?1048h/?1049h` unconditionally save/restore cursor. → client-side `surfaceReset` marker on attach is required; server emits preamble exactly when the marker is true.
- G5 test infra: shared JSON fixture dual-consumed by Rust + Node unit suites; CI gap budgeted (`cargo test -p freshell-terminal` absent from port-contract.yml); e2e accessor shape endorsed by xterm public typings (`ITerminal.modes`, `IBufferNamespace.active.type`); wheel→SGR channel via `recordSentWsMessage` feasible (xterm wheel path cited).

## Design (final)

**Rule:** the server is the architecture-of-record for emulator mode state; a per-terminal tracker consumes every output byte at the replay-append choke; on attach, when (and only when) the client asserts a fresh surface, the server prepends a synthesized mode preamble into the first replay bytes delivered to that socket. Content bytes, ring, and other sockets are untouched.

### Components

1. **Client minimal change (new; closes G4).** `buildTerminalAttachMessage` gains `surfaceReset: boolean` (`ws-protocol.ts` TerminalAttachSchema + `crates/freshell-protocol` mirror; regenerate port contracts). TerminalView computes it at attach: true exactly when the terminal's xterm surface is freshly created/reset for this attach (post-page-load mount attach, and any attach after local RIS user-reset or renderer-recreate within the page session — both tracked via the existing surface-generation refs; everything else (reconnect, reveal, refresh, load-more, quarantine repair) = false).
   - Server semantics: emit preamble iff `surfaceReset === true`. The replay content itself re-establishes everything else; `sinceSeq` content accounting is unchanged (preamble rides in the first replay frame's data, seq window shared with real content).
   - Hazard closure proof sketch: emission ⇒ surface fresh (by marker contract) ⇒ client surface is at defaults ⇒ every asserted mode set/reset, including 1004/1048/1049, lands on a default surface (1014…1004's focus keypress fires only if a focus-report handler is armed on a *live* pane's term: on a freshly mounted surface the app's true state IS 1004-on, so any spurious ESC[I the app receives is the report it asked for at startup per its own intent — and pane focus at attach round-trips to the app's true focus state. Monitor as accepted residual; if observed, drop 1004 from the synthesized set).

2. **Mode tracker (per terminal).** Choke co-located with existing barrier scanner (both servers). Byte-level state machine over the output stream:
   - Recognize `ESC [` and UTF-8 `C2 9B` CSI openers; parse to final byte; act ONLY on finals `h`/`l` for `? Pn` params (DEC private) and final `m` for `> Pm` (XTMODIFYKEYS resource sets). Split-sequence safety via 64-byte carry across chunks.
   - Family model: protocol slot ← last W-L-W semantics per {9,1000,1002,1003}; encoding slot per {1006,1016}; **independent** tracked modes for all other emitted `?Pn` (25, 47, 1000 handled via slot, 1004, 1047/1048/1049 buffer semantics collapsed per below, 2004, 2026…), plus XTMODIFYKEYS resource map.
   - Reset events: RIS (`ESC c`) → clear protocol slot to NONE, encoding slot to DEFAULT, clear tracked DEC privates (per G2's RIS table; cursor-hidden 25 survives RIS in xterm 6.0.0 — mirror that), XTMODIFYKEYS `>4;m`/`>4;0m` semantics appended to the tracker; DECSTR (`CSI ! p`) → apply G2's DECSTR mutation table.
   - 1047/1048/1049 special-case: track `?1049` state (alt buffer). On synthesis, fresh surface gets `?1049h` iff tracked set. 1048 tracked but NOT synthesized when standalone (save-cursor with no buffer switch has no fresh-surface meaning: emit only when 1049 set AND 1048 also set, mirroring the app's original combination).
   - Lifecycle keyed to (terminalId, streamId): Rust birth at registry create; Node birth at `getOrCreateTerminalState` (ring birth) — NEVER at earlier PTY spawn (Node brokers see no bytes there); Node extra death at `replaceStreamIdentity` (fresh tracker for new stream); drop at Node exit / Rust kill. Parity: `port` unit fixture, not wire identity.

3. **Preamble synthesis + injection (both servers).**
   - Byte shape: `CSI ? Pm h` / `CSI ? Pm l` per family slot / tracked mode, then `CSI > Pm m` XTMODIFYKEYS. Deterministic order (for parity fixture): modes sorted by param within (slot protocol, slot encoding, others h, others l, xtmodifykeys).
   - Injection point: Node — at per-socket batch/payload build (`buildTerminalOutputBatchPayload`/`buildTerminalOutputPayload` path from `flushReplayCursor`), reconstruct-on-copy: prepend preamble into segment[0].data; recompute `endOffset`s, `serializedBytes`, optional `segment.data` echoes; keep seq fields untouched. No-preamble fallback when replay slice is empty: emit a standalone terminal.output frame with seqStart=seqEnd=seq of first live frame… — G1a L10 proves duplicate windows drop; instead, for empty-replay fresh-surface attach, the server holds the preamble and prepends it into the FIRST LIVE frame the socket receives during/after attach (frames marked `source: 'live'`); if no live output ever arrives, the modes sync on first output (documented acceptable residual: xterm stays default until any output — the motivating case emits output constantly).
   - Rust equivalent: inside `registry.attach` before streaming the cloned replay vec (`deliver_batches` path), identical sibling live-prepend hold for empty replay.
   - Startup-probe interplay (G1a A-new-1): the preamble bytes `?2004h`/`?1004h` overlap codex probe steps and would disarm/advance that parser. Guard: when the client side detects fresh-surface attach it already resets the probe parser (TerminalView resets at attach, line 2790) — the preamble lands before genuine probe bytes; if probes were mid-flight in the replay tail (spawned < replay-window ago), the preamble disarms the probe suppressor and xterm auto-replies (ESC[?1;2c etc.): accepted residual, provably restricted to near-spawn attaches, benign for opencode (it already got its DECRPM answers via the bypass pre-refresh).

4. **Node↔Rust byte parity via shared fixture** (`port/oracle/baselines/mode-preamble/*.json`, input: tracked-state serialization, output: expected preamble bytes): consumed by Rust unit tests + Node vitest unit tests; CI wiring: add `cargo test -p freshell-terminal` (or the specific fixture test) to `port-contract.yml` — new step, budgeted.

5. **Scanner tests** (Rust + Node parity from the same fixture family): split-sequence carry; combined param lists; family slot W-L-W (opencode's 1003h→1002h→1003l → slot NONE); RIS/DECSTR tables; C1 UTF-8 form; DECRQM `$p` ignored; XTMODIFYKEYS `>4;1m` capture + `>4;m` reset semantics; 64-byte carry sufficiency (overflow → conservative resync: drop carry, log).

## Tasks

### Task 1 — Rust: tracker + preamble + gating
Sub-list: mode_tracker module with slot model + reset tables; wire into `ingest`; attach integration honoring `surfaceReset`; batch rebuild with offset recompute; live-prepend-hold for empty replay; unit tests + shared fixture consumption.

### Task 2 — Node parity
Same through broker/ring/payload path; same unit fixture; lifecycle hooks (`getOrCreateTerminalState`, `replaceStreamIdentity`, exit drop).

### Task 3 — Client marker + protocol schema
`surfaceReset` on TerminalAttachSchema both languages; compute in TerminalView; port-contract regen; unit coverage.

### Task 4 — e2e (multi-client.spec.ts, both matrix legs)
Tiny emitter pane (prints `?1003h ?1006h ?1049h >4;1m` once, then heartbeat); reload page in place; via new `__FRESHELL_TEST_HARNESS__.getTerminalModes` accessor (additive, per G5 sketch) assert `mouseTrackingMode === 'any'` + buffer type 'alternate'; synthesize page.mouse.wheel; assert `terminal.input` with `\x1b[<64;…M` on the wire. Additionally assert the hazard closure case: pane refresh (user action) on a tracked-`?1004h` pane must NOT produce an `ESC[I` terminal.input (marker=false ⇒ no preamble).

### Task 5 — live verification (same shape as PR#649 Task 3)
Scratch dev instance, real long-lived opencode session, hard refresh, wheel-scroll works immediately; then pane refresh ∀ no junk input; teardown by owned process group; gate + whole-branch review.

## Acceptance
- Task-4 e2e green on both servers; hazard-closure assertion green.
- Live hard-refresh mouse-scroll regression no longer reproducible.
- Gate: `npm run check` + cargo workspace green modulo ledgered flakes (jgpc / ep0f / xqfc).

## Accepted residuals
- Post-refresh panes with empty replay and no live app output keep default modes until first output byte.
- Near-spawn attaches (probes still in window) may lose probe suppression that attach (xterm auto-replies; harmless for opencode; watch for regression reports).
- 1004-on fresh-surface assertion may feed one synthetic focus report into apps at attach when a tracker says 1004 is on; mirrors startup intent; drop 1004 from the synthesized set if it proves noisy in practice.
- DECSCUSR cursor-shape sync not tracked (presentation nicety only).
- Wire marker lies are accepted as client bugs (not a security boundary).
