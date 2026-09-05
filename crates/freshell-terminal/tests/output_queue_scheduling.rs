//! Incremental output consumption must have the same wire order as drain_all,
//! including overflow gaps and non-evictable terminal.exit.
use freshell_protocol::{ServerMessage, TerminalExit, TerminalOutput};
use freshell_terminal::output_queue::{output_frame_meta, OutputQueue};

fn push(q: &mut OutputQueue, seq: i64) {
    let message = ServerMessage::TerminalOutput(TerminalOutput {
        terminal_id: "t".into(),
        stream_id: "s".into(),
        attach_request_id: Some("a".into()),
        seq_start: seq,
        seq_end: seq,
        data: format!("{seq}"),
        source: None,
    });
    let meta = output_frame_meta(&message).unwrap();
    q.push(message, 10, meta);
}
fn exit(q: &mut OutputQueue) {
    q.push_sequenced(ServerMessage::TerminalExit(TerminalExit {
        terminal_id: "t".into(),
        exit_code: 0,
    }));
}

#[test]
fn incremental_consumption_matches_full_drain_including_gaps_and_exit() {
    let mut incremental = OutputQueue::new(25);
    let mut full = OutputQueue::new(25);
    for q in [&mut incremental, &mut full] {
        for seq in 1..=5 {
            push(q, seq);
        }
        exit(q);
    }
    let mut messages = Vec::new();
    let mut removed_bytes = 0;
    while let Some((message, bytes)) = incremental.pop_front() {
        messages.push(message);
        removed_bytes += bytes;
    }
    assert_eq!(
        serde_json::to_value(messages).unwrap(),
        serde_json::to_value(full.drain_all()).unwrap()
    );
    assert_eq!(removed_bytes, 20);
    assert_eq!(incremental.pending_bytes(), 0);
    assert!(!incremental.has_pending());
}

#[test]
fn popping_one_frame_leaves_remaining_bytes_accounted() {
    let mut queue = OutputQueue::new(100);
    push(&mut queue, 1);
    push(&mut queue, 2);
    let (_, bytes) = queue.pop_front().unwrap();
    assert_eq!(bytes, 10);
    assert_eq!(queue.pending_bytes(), 10);
    assert_eq!(queue.pending_frames(), 1);
}

#[test]
fn overflow_after_a_partial_drain_keeps_tail_and_exit_order() {
    let mut queue = OutputQueue::new(20);
    push(&mut queue, 1);
    push(&mut queue, 2);
    queue.pop_front().unwrap();
    push(&mut queue, 3);
    push(&mut queue, 4);
    exit(&mut queue);
    let mut kinds = Vec::new();
    while let Some((message, _)) = queue.pop_front() {
        let value = serde_json::to_value(message).unwrap();
        kinds.push(value["type"].as_str().unwrap().to_string());
    }
    assert_eq!(
        kinds,
        vec![
            "terminal.output.gap",
            "terminal.output",
            "terminal.output",
            "terminal.exit"
        ]
    );
}

#[test]
fn gap_coalescing_never_crosses_attach_generations() {
    let mut queue = OutputQueue::new(1);
    for (seq, generation) in [(1, "old"), (2, "new")] {
        let message = ServerMessage::TerminalOutput(TerminalOutput {
            terminal_id: "t".into(),
            stream_id: "s".into(),
            attach_request_id: Some(generation.into()),
            seq_start: seq,
            seq_end: seq,
            data: "data".into(),
            source: None,
        });
        let meta = output_frame_meta(&message).unwrap();
        queue.push(message, 10, meta);
    }
    let first = serde_json::to_value(queue.pop_front().unwrap().0).unwrap();
    let second = serde_json::to_value(queue.pop_front().unwrap().0).unwrap();
    assert_eq!(first["attachRequestId"], "old");
    assert_eq!(second["attachRequestId"], "new");
    assert!(queue.pop_front().is_none());
}

#[test]
fn superseding_one_terminal_preserves_other_terminal_output_and_exit() {
    let mut queue = OutputQueue::new(100);
    push(&mut queue, 1);
    exit(&mut queue);
    let message = ServerMessage::TerminalOutput(TerminalOutput {
        terminal_id: "other".into(),
        stream_id: "other-stream".into(),
        attach_request_id: Some("other-attach".into()),
        seq_start: 1,
        seq_end: 1,
        data: "other data".into(),
        source: None,
    });
    let meta = output_frame_meta(&message).unwrap();
    queue.push(message, 20, meta);
    queue.discard_terminal("t");
    assert_eq!(queue.pending_bytes(), 20);
    let value = serde_json::to_value(queue.pop_front().unwrap().0).unwrap();
    assert_eq!(value["terminalId"], "other");
    assert!(queue.pop_front().is_none());
}
