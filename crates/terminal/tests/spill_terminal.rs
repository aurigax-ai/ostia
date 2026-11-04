#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;

use history_support::{mark, numbered, strip_vt};
use ostia_terminal::history_spill::{SPILL_BATCH, SpillSink};
use ostia_terminal::spill_terminal::SpillTerminal;
use parking_lot::Mutex;

#[derive(Default)]
struct Recorded {
    lines: Vec<String>,
    wipes: usize,
    flushes: usize,
}

#[derive(Default)]
struct RecordingSink {
    recorded: Mutex<Recorded>,
}

impl SpillSink for RecordingSink {
    fn end(&self) -> u64 {
        u64::try_from(self.recorded.lock().lines.len()).unwrap()
    }

    fn live(&self) -> bool {
        true
    }

    fn append(&self, lines: &[String]) {
        self.recorded.lock().lines.extend_from_slice(lines);
    }

    fn block_started(&self, _seq: u64, _start: u64, _command: Option<&str>) {}

    fn block_ended(
        &self,
        _seq: u64,
        _end: u64,
        _end_col: u64,
        _exit_code: i32,
        _command: Option<&str>,
    ) {
    }

    fn wipe(&self) {
        self.recorded.lock().wipes += 1;
    }

    fn flush(&self) {
        self.recorded.lock().flushes += 1;
    }
}

fn batch() -> u64 {
    u64::try_from(SPILL_BATCH).unwrap()
}

#[test]
fn ignores_writes_resizes_and_restores_after_close_and_returns_the_same_end_twice() {
    let sink = Arc::new(RecordingSink::default());
    let mut spill = SpillTerminal::new(80, 24, sink.clone(), 5).unwrap();
    spill.write(format!("{}{}", mark("C"), mark("D;0")).as_bytes());
    let end = spill.close();
    assert_eq!(end, 6);
    let lines_at_close = sink.recorded.lock().lines.len();
    spill.write(numbered(0, 3 * batch()).as_bytes());
    spill.resize(100, 30);
    spill.restore("restored", false);
    spill.resync("screen");
    assert!(spill.tail().is_empty());
    assert!(spill.pending_end(6).is_none());
    assert_eq!(spill.close(), 6);
    assert_eq!(sink.recorded.lock().lines.len(), lines_at_close);
}

#[test]
fn keeps_its_size_for_a_resize_below_one_and_flushes_the_sink_once_on_close() {
    let sink = Arc::new(RecordingSink::default());
    let mut spill = SpillTerminal::new(80, 24, sink.clone(), 0).unwrap();
    spill.resize(0, 10);
    spill.resize(10, 0);
    spill.write(numbered(0, 5).as_bytes());
    spill.close();
    spill.close();
    let recorded = sink.recorded.lock();
    assert_eq!(recorded.lines.len(), 5);
    assert_eq!(recorded.flushes, 1);
}

#[test]
fn keeps_the_frontier_when_a_wrapped_line_crosses_the_scrollback_edge() {
    let sink = Arc::new(RecordingSink::default());
    let mut spill = SpillTerminal::new(10, 5, sink.clone(), 0).unwrap();
    spill.write(numbered(0, 400).as_bytes());
    spill.write(format!("{}\r\n", "x".repeat(10 * 200)).as_bytes());
    spill.write(numbered(400, 300).as_bytes());
    spill.close();
    let mut expected: Vec<String> = (0..400).map(|i| format!("out {i}")).collect();
    expected.push("x".repeat(10 * 200));
    expected.extend((400..700).map(|i| format!("out {i}")));
    let recorded = sink.recorded.lock();
    let plain: Vec<String> = recorded.lines.iter().map(|line| strip_vt(line)).collect();
    assert_eq!(plain, expected);
}

#[test]
fn wipes_the_history_on_a_scrollback_clear_that_follows_an_unterminated_string() {
    for opener in ["\x1b]0;title", "\x1bPq", "\x1b_apc"] {
        let sink = Arc::new(RecordingSink::default());
        let mut spill = SpillTerminal::new(80, 24, sink.clone(), 0).unwrap();
        spill.write(numbered(0, 5).as_bytes());
        spill.write(format!("{opener}\x1b[3J").as_bytes());
        assert_eq!(sink.recorded.lock().wipes, 1, "{opener:?}");
    }
}
