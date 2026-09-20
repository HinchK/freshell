//! TERM-09 output-frame identity and the default per-connection byte cap.
//!
//! The bounded, drop-oldest, byte-fair per-connection terminal-output queue
//! itself lives in `freshell-ws::terminal::connection_writer`'s
//! `terminal_delivery_queue` module: connection-local focused/visible/
//! background scheduling with a global-oldest evictable index, generation-
//! scoped gap coalescing, and non-evictable ZERO-WEIGHT sequenced controls
//! (`terminal.exit` can never be dropped, evicted, or trip the byte cap;
//! it is count-bounded by the independent metadata limit). Connection death
//! with 4008 happens only when evictable output is exhausted while over the
//! cap. This module keeps only the pieces that are referenced
//! across crate boundaries: the default cap and the output-frame metadata
//! extraction the writer needs to classify and (on eviction) synthesize a
//! [`ServerMessage::TerminalOutputGap`] with
//! `reason: TerminalOutputGapReason::QueueOverflow` (legacy parity:
//! `client-output-queue.ts` `extendGap` + `broker.ts` `sendGap`).

use freshell_protocol::ServerMessage;

/// Default cap (responsive-terminal-restore Workstream 3: the SPILL bound —
/// eviction + generation-scoped gap — that normal output pressure reaches
/// strictly before any pressure-related disconnect; the disconnect threshold
/// lives in `freshell-ws::backpressure::Term09Config` and must stay strictly
/// above this). Legacy `client-output-queue.ts:33` shipped 32 MiB, which sat
/// ABOVE legacy's 16 MiB catastrophic-disconnect threshold — the inversion
/// that disconnected the production incident's ~21-25 MB backlog instead of
/// spilling it. 16 MiB keeps a multi-second grace buffer for a slow-but-
/// draining client while the byte-fair scheduler keeps other panes
/// responsive; the incident backlog spills gracefully here instead of
/// disconnecting.
pub const DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;

/// The identity fields a queued output frame needs so a gap event can be
/// built if it's later evicted. Mirrors the fields `ReplayFrame` carries in
/// legacy (`seqStart`/`seqEnd`/`streamId`) plus the `attachRequestId`
/// `client-output-queue.ts`'s `GapEvent` omits but `broker.ts` attaches when
/// sending (`sendGap`, `broker.ts:1717-1739`) -- carried here instead so
/// the delivery queue alone is sufficient to build the exact wire shape.
#[derive(Debug, Clone)]
pub struct OutputFrameMeta {
    pub terminal_id: String,
    pub stream_id: String,
    pub seq_start: i64,
    pub seq_end: i64,
    pub attach_request_id: Option<String>,
}

/// Extract [`OutputFrameMeta`] from a `ServerMessage` if it's a live terminal
/// output frame (`TerminalOutput` or `TerminalOutputBatch`) -- the ONLY two
/// variants legacy's `ClientOutputQueue` ever queues. Returns `None` for
/// every other variant, telling the caller to deliver it directly instead
/// (unbounded, exactly as legacy never subjects it to the cap).
pub fn output_frame_meta(msg: &ServerMessage) -> Option<OutputFrameMeta> {
    match msg {
        ServerMessage::TerminalOutput(out) => Some(OutputFrameMeta {
            terminal_id: out.terminal_id.clone(),
            stream_id: out.stream_id.clone(),
            seq_start: out.seq_start,
            seq_end: out.seq_end,
            attach_request_id: out.attach_request_id.clone(),
        }),
        ServerMessage::TerminalOutputBatch(batch) => Some(OutputFrameMeta {
            terminal_id: batch.terminal_id.clone(),
            stream_id: batch.stream_id.clone(),
            seq_start: batch.seq_start,
            seq_end: batch.seq_end,
            attach_request_id: Some(batch.attach_request_id.clone()),
        }),
        _ => None,
    }
}
