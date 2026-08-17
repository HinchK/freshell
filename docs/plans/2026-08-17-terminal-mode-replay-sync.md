# Terminal mode replay sync — plan (v3, two load-bearing rounds closed)

## Context

After any browser page load, a pane's xterm is recreated and rehydrated from the server's retained replay buffer. Apps enable DEC private modes (mouse `?1000/?1002/?1003h`, SGR mouse `?1006h`, alt screen `?1049h`, cursor `?25l`, bracketed paste `?2004h`, focus `?1004h`) and XTMODIFYKEYS (`CSI >4;1m`) **once at startup**; those bytes scroll out of the retained window, so the recreated xterm reverts to defaults and wheel input is never forwarded (`mouseTrackingMode === 'none'`). Proven live 2026-08-16 (1.7 MB replay tail contained zero mouse sequences; fresh opencode emits the full set in its first burst; resize does not re-emit). Distinct from the geometry-stomp fix (PR #649).

## Load-bearing disposition (rounds 1+2)

- **R-1 wire encoding**: seq-frame surgery dead; v3 message type survives (see Validator C ordering proof, Validator D write-path proof).
- **R-2 contract**: additive optional `surfaceReset` + new `terminal.modes.sync` server→client type; WS protocol version stays 7; all four old/new quadrants valid (Zod non-strict strips, serde accept-and-strip with zero real `deny_unknown_fields`, client dispatch has no default-reject). Gated files enumerated incl. `crates/freshell-protocol/tests/inventory.rs` hard counts (57→58 / 87→88) and gateway: `port-contract.yml` (test:port + regen-idempotency + `cargo test -p freshell-protocol`).
- **R-3 delivery machinery**: `terminal.modes.sync` sent by immediate `safeSend`(Node: broker.ts between :520-522) / `sink`(Rust: registry.rs:1262) inside the attach critical section; strictly ready < sync < replay < live (Node: sync section contains zero awaits, replay flushes on later macrotask; Rust: reader blocked on the per-terminal lock, comment registry.rs:1230-1232). Bypasses every loss channel (queue overflow, supersede/detach discards — all operate on queued output; sync never enters the queue). Empty-replay problem deleted by construction (sync is seq-less).
- **R-4 probe interplay**: sync bytes never traverse `handleTerminalOutput`/extractors (sole funnel proven); near-spawn probe disarm removal; DECRQM/OSC/title side effects suppressed because sync writes use `mode: 'replay'` write-scope.
- **R-new (sync tagging)**: sync carries `attachRequestId` AND `streamId` (isCurrentAttachStreamMessage guard, TerminalView:2557-2701); untagged → fail closed (`missing_attach_request_id` reject); handler additionally rejects when `currentAttachRef.current === null`.
- **R-new (Rust channel pin)**: `TerminalModesSync` must route the direct channel (output_frame_meta wildcard → None today); pin with a unit test so a future queue-delegation edit can't break ready<sync<replay.
- **xterm facts (G2/E)**: family-slot semantics verified ({9,1000,1002,1003} one protocol slot, {1006,1016} one encoding slot, W-L-W unconditional clears); RIS resets everything except cursor-hidden(25); DECSTR broad but NOT mouse; `?1049h/l` idempotent (active-buffer last-wins law); 47/1047/1049 fold into one alt state (hazard if not); 1048 never synthesized standalone; emit-as-tracked policy for ?1049 chosen with bounded artifact budget.
- **App traffic (G3)**: no RIS/DECSTR/C1 in opencode/vim/tmux startup+teardown (byte-faithful capture, C1-corruption-safe harness); scanner handles them anyway (cheap); kitty `>7u/<u` keyboard stack = deferred residual (own cycle).
- **Scanner domain (F)**: both servers scan decoded strings (node-pty default UTF-8; Rust Utf8StreamDecoder lossy port); openers = `ESC[` + U+009B; 64-CODE-POINT carry (existing constant on both scanners: output-barrier-scanner.ts:44 / barrier_scanner.rs:105); U+FFFD = ground content, resync; Node tracker scans the PRE-normalize data at replay-ring.ts:63; fixtures authored in decoded-string domain.
- **Client marker (A + F)**: new `surfaceFreshRef` (positive polarity). SET at exactly two sites: init-effect construction (TerminalView.tsx:2048, covers mount-fresh + renderer-recreate — one construction site) and user reset (term.reset() at :2215). NOT on term.clear() (:2796) nor cleanup. CLEAR at first applied write of a non-stale generation — anchor terminal-write-queue.ts:134 after the :133 stale guard (wire via new optional onWriteApplied; parity direct-write mirror :1680-1704). Read synchronously at buildTerminalAttachMessage send (~:2859-2869). Required addition (A-5.1): when `surfaceFreshRef.current` is true, the attach MUST force `intent='viewport_hydrate'`, `sinceSeq=0` (else a checkpoint-blessed delta would continue content onto a fresh blank surface — data hole). The hidden-attach wire swap (:2765-2766) applies after this resolution.
- **Hazard-closure e2e (F)**: harness dispatch `{type:'panes/requestPaneRefresh', payload:{tabId,paneId}}` (slice panesSlice.ts:985/1593), PRECONDITION pane content already terminalId-folded; no `.focus()` on the refresh chain; assertion after settle: no terminal.input containing `\x1b[I`/`\x1b[O`.
- **1049 ordering (E-A5)**: synthesize `?1049h` before any cursor-effect bytes (only 1048 matters; trivially satisfied by param sort).

## Design (final)

**Server tracks a per-terminal emulator-state projection from the output stream; the client marks attach frames with `surfaceReset` only when its xterm surface is fresh; on such attaches (only), the server emits one `terminal.modes.sync` message (attachRequestId + streamId + data) immediately after `terminal.attach.ready` and before replay; the client writes it through the generation-gated write queue with replay-side-effect suppression. Everything else (seq accounting, replay content, ring contents, other sockets) is untouched.**

### 1. Mode tracker (both servers, one spec)

- Placement: Node — inside `ReplayRing.append` next to `barrierScanner` (replay-ring.ts:62-63), scanning the pre-normalize `data`; serve-lived at `getOrCreateTerminalState` (ring birth). Rust — inside `registry.rs ingest` beside `s.scanner` (:2614), per-terminal existing scanner slot.
- String-domain state machine: CSI openers `ESC[` + U+009B; finals `h/l` for `?Pn` (DEC private), final `m` for `>Pm` (XTMODIFYKEYS resource sets, incl. `>4;m`/`>4;0m` clears); plain `ESC c` (RIS → clear protocol slot + encoding slot + all tracked DEC privates except 25 which xterm leaves); `CSI ! p` (DECSTR → apply the verified DECSTR table: clears ?1,?6,?45,?66,?1004,?2004,?2026, cursor visibility(25), margins, saved cursor; NOT mouse families); `$p`/`$y` finals never mutate (DECRQM guard).
- State: protocol slot ({9,1000,1002,1003}), encoding slot ({1006,1016}), flat map of other tracked ?Pn, XTMODIFYKEYS resource map, alt-folded {47,1047,1049}. 64-code-point carry, U+FFFD resync, 128-entry overflow eviction (log).
- Lifecycle (L5 spec): keyed to (terminalId, streamId); Node birth at getOrCreateTerminalState, extra death at replaceStreamIdentity; dropped at exit (Node broker exit) / kill (Rust row removal).

### 2. Preamble synthesis + sync emission

- Byte shape from tracker state: deterministic param-sorted sequence of `CSI ? Pm h/l` (protocol slot leader h or family-clear l; encoding likewise; then flat modes; then XTMODIFYKEYS `>Pm m`), `?1049h` placed before any other cursor-affecting bytes (only 1048 interplay; none emitted standalone).
- Emission condition: `attach.surfaceReset === true` only. Node insertion broker.ts:520-522 (after ready guard, pre-gap); Rust insertion registry.rs:1262 (after `sink(ready)`) — including the dead-terminal Exited path (sync of frozen state is correct for retained-tail rendering; client must tolerate sync-immediately-followed-by-exit edge).
- Payload: `{ type:'terminal.modes.sync', terminalId, attachRequestId, streamId, data }`. No seq fields (control-plane).
- Direct-channel pin (Rust): test that output_frame_meta returns None for TerminalModesSync.

### 3. Client changes (minimal, two files)

- `shared/ws-protocol.ts`: `TerminalAttachSchema` +`surfaceReset: z.boolean().optional()`; new `TerminalModesSyncMessage` TS type (previousSessionId modeling precedent: TS-type-only, server→client, not client-validated) in `ServerMessage` union. `crates/freshell-protocol`: TerminalAttach +`surface_reset: Option<bool>` (skip_serializing_if); server_messages.rs new variant + `SERVER_MESSAGE_TYPES` 57→58; tests/inventory.rs counts 57→58 / 87→88; fix the stale "52 discriminants"/"27 discriminants" header comments (pre-existing drift).
- `TerminalView.tsx`: `surfaceFreshRef` (SET :2048 & :2215; CLEAR via write-queue :134 stale-guarded first-applied callback; wired through createTerminalWriteQueue new optional onWriteApplied); `attachTerminal` downgrade rule (`surfaceFresh ⇒ intent='viewport_hydrate', sinceSeq=0, clearViewportFirst:false`); pass marker into buildTerminalAttachMessage; new handler case at :3486 chain:
  ```ts
  if (msg.type === 'terminal.modes.sync' && msg.terminalId === tid) {
    if (!currentAttachRef.current) return
    if (!isCurrentAttachStreamMessage(msg)) return
    if (typeof msg.data !== 'string' || msg.data.length === 0) return
    writeQueueRef.current?.enqueue(msg.data, undefined, { mode: 'replay', generation: msg.attachRequestId })
  }
  ```
- Port-contract regen committed in the PR; CI already gates regen idempotency.

### 4. Parity fixture

One shared JSON family `port/oracle/baselines/mode-preamble/*.json` (input: tracker state serialization + attach flag; expected: sync data bytes). Consumed by Rust unit tests and Node vitest unit tests (mirrors the baselines/batch golden pattern). Budgeted CI step: add `cargo test -p freshell-terminal` (at least the fixture test) to port-contract.yml — currently missing (G5-A1).

### 5. E2E (multi-client.spec.ts, both matrix legs)

- Happy path: emitter pane sets `?1003h ?1006h ?1049h >4;1m` once, heartbeats; reload page; via new harness accessor `getTerminalModes(terminalId)` (additive, per G5 sketch — returns IModes + bufferType) assert `mouseTrackingMode==='any'` + `'alternate'`; `page.mouse.wheel` over pane → `terminal.input` with `\x1b[<64;` on wire.
- Hazard closure: tracked-`?1004h` pane, harness dispatch `panes/requestPaneRefresh` (after content-terminalId fold), settle 400ms, assert zero `terminal.input` containing `\x1b[I`/`\x1b[O`.
- Marker-forcing rule coverage: renderer-recreate (settings change) → next attach has surfaceReset=true AND sinceSeq=0 (no delta-on-blank-surface).

### 6. Live verification (same shape as PR#649 Task 3)

Scratch dev instance (setsid, pinned ports, owned process-group teardown), long-lived real opencode pane, hard refresh, immediate wheel scroll works; pane refresh produces no junk input; user-reset + reconnect reproducibility sweep.

## Tasks

1. **Rust**: mode scanner (string-domain; verified tables), tracker at ingest, sync emission at registry attach, direct-channel pin test, fixture consumption. TDD.
2. **Node parity**: same in ReplayRing/broker (getOrCreateTerminalState birth, replaceStreamIdentity death, pre-normalize scan ordering), broker.ts:520 insertion, fixture consumption.
3. **Client + protocol**: schema/type additions, surfaceFreshRef lifecycle, attach downgrade rule, sync handler, port-contract regen, inventory counts fix, unit coverage (lifecycle file).
4. **E2E** per §5 (accessor additive surface included).
5. **Live verification** per §6 + gate (`npm run check` + cargo workspace green modulo ledgered flakes jgpc/ep0f/xqfc) + whole-branch review.

## Acceptance

- E2E green on both servers, incl. hazard-closure and marker/downgrade assertions.
- Live hard-refresh mouse-scroll regression not reproducible; pane refresh produces no junk input.
- Gate green modulo ledgered pre-existing flakes.

## Accepted residuals (all deliberately surfaced and chosen)

- Kitty keyboard `>7u/<u` stack not tracked (needs own cycle; kodas: to file).
- `?1004h` on a fresh surface may cause one synthetic focus report to reach apps that armed 1004 — mirrors what the app requested at startup; drop from synthesized set if noisy in practice.
- Bounded 1049 artifact: if the app later exits alt in live streaming after an in-window freshell-era entry, normal-buffer contents/cursor are approximate (Case-1/Case-2 tables, Validator E). Self-heals on repaint; accepted.
- User-reset asymmetry (A-5.2): if a ws attach happens before any output after a user Reset, history replays from 0 (reset ephemeral) rather than staying wiped; after any applied output the wipe persists via delta continuity. Chosen: server history is authority; Reset wipes the VIEW only.
- Sync-immediately-followed-by-exit (Rust dead-terminal attach) is legal on the wire; client tolerates (sync applies, then synthesized exit).
- Same-attachRequestId literal duplicate: Node suppresses (broker.ts:344-347), Rust re-emits idempotently. Idempotent re-assert on a fresh surface is safe by the fresh-surface premise (A3 premise owned by marker design).

## Katas to file on landing

- Kitty keyboard stack replay loss (deferred this branch).
- `cargo test -p freshell-terminal` missing from port-contract.yml (add in this branch; kata only if descoped).
