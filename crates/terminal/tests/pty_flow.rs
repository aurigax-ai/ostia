#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_terminal::pty_flow::{
    CoalescedOutput, FLOW_HIGH_WATERMARK, FLOW_LOW_WATERMARK, FLOW_STALL_MS, FlowMarks, FlowTarget,
    PtyFlowControl,
};
use parking_lot::Mutex;

#[derive(Clone, Default)]
struct FakePty {
    calls: Arc<Mutex<Vec<&'static str>>>,
}

impl FakePty {
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().clone()
    }

    fn flow(&self) -> PtyFlowControl {
        PtyFlowControl::new(Arc::new(self.clone()))
    }
}

impl FlowTarget for FakePty {
    fn pause(&self) {
        self.calls.lock().push("pause");
    }

    fn resume(&self) {
        self.calls.lock().push("resume");
    }
}

fn shown() -> bool {
    true
}

fn stall() -> Duration {
    Duration::from_millis(FLOW_STALL_MS)
}

async fn next_turn() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

fn collector() -> (Arc<Mutex<Vec<String>>>, CoalescedOutput) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&sent);
    let out = CoalescedOutput::new(move |data| sink.lock().push(data));
    (sent, out)
}

#[tokio::test]
async fn sends_one_message_for_every_chunk_pushed_in_the_same_turn() {
    let (sent, out) = collector();
    for i in 0..500 {
        out.push(&format!("line {i}\n"));
    }
    assert!(sent.lock().is_empty());
    next_turn().await;
    let sent = sent.lock();
    assert_eq!(sent.len(), 1);
    let expected: String = (0..500).map(|i| format!("line {i}\n")).collect();
    assert_eq!(sent[0], expected);
}

#[tokio::test]
async fn delivers_what_is_queued_at_once_on_flush_keeping_order() {
    let (sent, out) = collector();
    out.push("a");
    out.push("b");
    out.flush();
    out.push("c");
    next_turn().await;
    assert_eq!(*sent.lock(), vec!["ab".to_owned(), "c".to_owned()]);
}

#[tokio::test]
async fn drops_queued_output_and_ignores_later_pushes_once_closed() {
    let (sent, out) = collector();
    out.push("a");
    out.close();
    out.push("b");
    next_turn().await;
    assert!(sent.lock().is_empty());
}

#[tokio::test]
async fn ignores_an_empty_push_and_a_flush_with_nothing_queued() {
    let (sent, out) = collector();
    out.push("");
    out.flush();
    next_turn().await;
    assert!(sent.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn pauses_a_lane_with_its_own_marks_only_past_its_high_mark_and_resumes_at_its_low_mark() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open_with_marks(
        "history",
        shown,
        FlowMarks {
            high: 1000,
            low: 200,
        },
    );
    lane.sent(1000);
    assert_eq!(pty.calls(), Vec::<&str>::new());
    lane.sent(1);
    assert_eq!(pty.calls(), ["pause"]);
    flow.ack("history", 700);
    assert_eq!(pty.calls(), ["pause"]);
    flow.ack("history", 101);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn pauses_above_the_high_watermark_and_resumes_once_acknowledged_below_the_low_one() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open("w1", shown);
    lane.sent(FLOW_HIGH_WATERMARK);
    assert_eq!(pty.calls(), Vec::<&str>::new());
    lane.sent(1);
    assert_eq!(pty.calls(), ["pause"]);
    lane.sent(10);
    assert_eq!(pty.calls(), ["pause"]);
    flow.ack("w1", FLOW_HIGH_WATERMARK + 11 - FLOW_LOW_WATERMARK - 1);
    assert_eq!(pty.calls(), ["pause"]);
    flow.ack("w1", 2);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    assert!(!flow.is_paused());
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn resumes_a_paused_pty_when_the_renderer_that_held_it_detaches() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open("w1", shown);
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    lane.close();
    assert_eq!(pty.calls(), ["pause", "resume"]);
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    assert_eq!(pty.calls(), ["pause", "resume"]);
}

#[tokio::test(start_paused = true)]
async fn resumes_when_a_crashed_renderer_is_released_and_stops_counting_what_it_is_still_sent() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open("w1", shown);
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    flow.release("w1");
    assert_eq!(pty.calls(), ["pause", "resume"]);
    lane.sent(FLOW_HIGH_WATERMARK * 3);
    assert!(!flow.is_paused());
}

#[tokio::test(start_paused = true)]
async fn a_re_attach_replaces_the_lane_so_the_old_one_closing_later_does_not_drop_the_new_one() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let old = flow.open("w1", shown);
    old.sent(FLOW_HIGH_WATERMARK + 1);
    let fresh = flow.open("w1", shown);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    old.close();
    fresh.sent(FLOW_HIGH_WATERMARK + 1);
    assert_eq!(pty.calls(), ["pause", "resume", "pause"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn only_pauses_for_a_lane_over_the_high_watermark_and_waits_for_every_lane_to_drain() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let a = flow.open("a", shown);
    let b = flow.open("b", shown);
    a.sent(FLOW_HIGH_WATERMARK + 1);
    b.sent(FLOW_HIGH_WATERMARK);
    flow.ack("a", FLOW_HIGH_WATERMARK + 1);
    assert_eq!(pty.calls(), ["pause"]);
    flow.ack("b", FLOW_HIGH_WATERMARK);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn ignores_acknowledgements_from_unknown_senders_and_non_positive_counts() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open("w1", shown);
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    flow.ack("w2", FLOW_HIGH_WATERMARK);
    flow.ack("w1", -FLOW_HIGH_WATERMARK);
    flow.ack("w1", 0);
    assert_eq!(pty.calls(), ["pause"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn resumes_a_pty_whose_renderer_stopped_acknowledging_hidden_or_hung_window() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let lane = flow.open("w1", shown);
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    tokio::time::advance(stall() - Duration::from_millis(1)).await;
    flow.ack("w1", 1);
    tokio::time::advance(stall() - Duration::from_millis(1)).await;
    assert_eq!(pty.calls(), ["pause"]);
    tokio::time::advance(Duration::from_millis(1)).await;
    next_turn().await;
    assert_eq!(pty.calls(), ["pause", "resume"]);
    lane.sent(FLOW_HIGH_WATERMARK);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn never_touches_the_pty_after_dispose() {
    let pty = FakePty::default();
    let flow = pty.flow();
    flow.open("w1", shown).sent(FLOW_HIGH_WATERMARK + 1);
    flow.dispose();
    tokio::time::advance(stall() * 2).await;
    next_turn().await;
    assert_eq!(pty.calls(), ["pause"]);
}

#[tokio::test(start_paused = true)]
async fn never_pauses_for_a_hidden_window_however_much_it_has_not_acknowledged() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let visible = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&visible);
    let lane = flow.open("w1", move || seen.load(Ordering::SeqCst));
    lane.sent(FLOW_HIGH_WATERMARK * 10);
    assert_eq!(pty.calls(), Vec::<&str>::new());
    visible.store(true, Ordering::SeqCst);
    lane.sent(FLOW_HIGH_WATERMARK);
    assert_eq!(pty.calls(), Vec::<&str>::new());
    lane.sent(1);
    assert_eq!(pty.calls(), ["pause"]);
    flow.dispose();
}

#[tokio::test(start_paused = true)]
async fn resumes_a_paused_pty_at_once_when_its_window_is_hidden_or_minimized() {
    let pty = FakePty::default();
    let flow = pty.flow();
    let visible = Arc::new(AtomicBool::new(true));
    let seen = Arc::clone(&visible);
    let lane = flow.open("w1", move || seen.load(Ordering::SeqCst));
    lane.sent(FLOW_HIGH_WATERMARK + 1);
    visible.store(false, Ordering::SeqCst);
    flow.hidden("w1");
    assert_eq!(pty.calls(), ["pause", "resume"]);
    lane.sent(FLOW_HIGH_WATERMARK * 10);
    assert_eq!(pty.calls(), ["pause", "resume"]);
    flow.dispose();
}

#[test]
fn uses_the_documented_flow_numbers() {
    assert_eq!(FLOW_HIGH_WATERMARK, 100_000);
    assert_eq!(FLOW_LOW_WATERMARK, 5_000);
    assert_eq!(FLOW_STALL_MS, 1_000);
}
