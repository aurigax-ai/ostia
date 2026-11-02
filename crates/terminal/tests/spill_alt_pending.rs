#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::sync::Arc;

use history_support::mark;
use ostia_terminal::history_spill::SpillSink;
use ostia_terminal::spill_terminal::SpillTerminal;

struct QuietSink;

impl SpillSink for QuietSink {
    fn end(&self) -> u64 {
        0
    }

    fn live(&self) -> bool {
        true
    }

    fn append(&self, _lines: &[String]) {}

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

    fn wipe(&self) {}

    fn flush(&self) {}
}

#[test]
fn keeps_the_pending_block_end_while_a_full_screen_program_runs() {
    let mut spill = SpillTerminal::new(20, 24, Arc::new(QuietSink), 0).unwrap();
    spill.write(
        format!(
            "{}{}\r\nshort\r\n{}\r\n{}$ ",
            mark("C"),
            "w".repeat(70),
            "v".repeat(45),
            mark("D;3")
        )
        .as_bytes(),
    );
    let before = spill.pending_end(1).unwrap();
    assert_eq!(before.exit_code, 3);
    spill.write(b"\x1b[?1049hALTERNATE\r\nmore");
    assert_eq!(spill.pending_end(1), Some(before));
    spill.write(b"\x1b[?1049l");
    assert_eq!(spill.pending_end(1), Some(before));
}
