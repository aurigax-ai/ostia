#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;

use history_support::{mark, numbered};
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
