# mode-preamble baselines — cross-language tracker/synthesis contract

Authoritative byte-level contract for the per-terminal mode tracker that feeds
`terminal.modes.sync`. Both servers (Node `ReplayRing`/`broker`, Rust
`registry` ingest) implement exactly this state machine; fixtures pin it.

## Input domain

Decoded STRING domain (post UTF-8 lossy decode: node-pty default UTF-8;
Rust `Utf8StreamDecoder` port). Openers: `ESC [` and C1 `U+009B`. A partial
sequence may span chunk boundaries: the scanner carries at most 64 code
points of pending bytes between chunks. `U+FFFD` (decode replacement)
appearing inside a pending escape ABORTS the escape and re-enters ground
state (it is text, not structure).

## Tracked state

- **mouse protocol slot** over `{9,1000,1002,1003}`: `CSI ? Pm h` with Pm in
  the family sets the slot to Pm (last-wins, including multi-param lists).
  `CSI ? Pm l` with ANY Pm in the family clears the slot unconditionally
  (W-L-W law: the reset need not name the leader).
- **SGR encoding slot** over `{1006,1016}`: same rules.
- **alt buffer slot** over `{47,1047,1049}`: same rules. Emitted as the
  leader's literal bytes (emit-as-tracked).
- **flat DEC private modes**: every other `?Pm` seen, param → bool
  (h sets, l clears). Multi-param lists apply per element. `?25` is special
  only at synthesis time (below). `?2026` and `?1004` are tracked but never
  emitted (`?1004` because xterm 6.0.0 fires an immediate focus report on
  EVERY arm — replaying it would deterministically inject `ESC[I` junk into
  the app's stdin on a fresh focused surface; caught by the hazard e2e).
- **XTMODIFYKEYS resource map**: `CSI > Pm ; Pv m` sets resource Pm=Pv;
  `CSI > Pm ; m` or `CSI > Pm ; 0 m` sets Pv=0 (clear). Tracked for fidelity,
  never emitted (xterm 6.0.0 has no modifyOtherKeys handling).
- `$p`/`$y` finals (DECRQM/DECRQSS) NEVER mutate state.

## Reset semantics (verified against xterm 6.0.0 InputHandler)

- RIS (`ESC c`): clears mouse protocol slot, SGR encoding slot, alt slot,
  ALL flat modes EXCEPT `?25` (xterm leaves cursor visibility alone), and
  the XTMODIFYKEYS map.
- DECSTR (`CSI ! p`): deletes `?1, ?6, ?45, ?66, ?1004, ?2004, ?2026, ?25`
  from the flat map (cursor becomes visible = default). NOT mouse families,
  NOT the alt slot, NOT XTMODIFYKEYS.

## Synthesis (tracker state → sync `data`)

1. Collect enables: protocol slot leader, encoding slot leader, alt leader,
   every flat param with value true.
2. Emit ascending numeric order as `ESC [ ? Pm h`, EXCLUDING `?2026` and
   `?1004` (see above).
3. If `?25` is explicitly tracked as FALSE, append `ESC [ ? 2 5 l` after all
   enables (default surface is cursor-visible; an explicit `?25h` is emitted
   like any other enable when tracked as true).
4. `?1049h` ahead of cursor-affecting bytes is trivially satisfied: `?1048`
   is never synthesized standalone and `?25` disable is trailing.

## Fixture schema (`*.json`)

```json
{
  "name": "…",
  "chunks": ["raw output stream strings, JSON-escaped"],
  "surfaceReset": true,
  "expectedSyncData": "exact bytes the server must emit …, or \"\" (no frame)"
}
```

Semantics: feed `chunks` in order through the tracker's ingest path (Node: a
fresh `ReplayRing`'s `append` sequence — scan is pre-normalize; Rust: the
tracker's scan path directly), then synthesize. `expectedSyncData == ""`
means NO `terminal.modes.sync` frame may be emitted (empty tracker or
`surfaceReset == false`): both servers skip emission for empty data or
absent/false flag.
