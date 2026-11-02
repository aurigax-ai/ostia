use std::sync::Arc;

use ostia_base::js::js_number;

use crate::headless_screen::HeadlessScreen;
use crate::history_spill::{BlockEnd, HistorySpill, SPILL_BATCH, SpillSink};

use crate::vt_observer::{Observer, Sequence, any_alternate_screen_mode, first_param};

pub const SPILL_SCROLLBACK: usize = 4 * SPILL_BATCH;

const MODES_RESET: &str = "\x1b[?1049l\x1b[!p\x1b[0m";
const LINES_PER_SLICE: usize = 128;
const LINE_FEED: u8 = 0x0a;

pub struct SpillTerminal {
    screen: HeadlessScreen,
    spill: HistorySpill,
    observer: Observer,
    target_cols: u16,
    target_rows: u16,
    closed: bool,
}

impl SpillTerminal {
    pub fn new(
        cols: u16,
        rows: u16,
        sink: Arc<dyn SpillSink>,
        seq_offset: u64,
    ) -> Result<Self, String> {
        let target_cols = cols.max(1);
        let target_rows = rows.max(1);
        let screen = HeadlessScreen::new(target_cols, target_rows, SPILL_SCROLLBACK)?;
        let spill = HistorySpill::new(&screen, sink, seq_offset);
        Ok(Self {
            screen,
            spill,
            observer: Observer::new(),
            target_cols,
            target_rows,
            closed: false,
        })
    }

    pub fn write(&mut self, data: &[u8]) {
        if self.closed {
            return;
        }
        self.feed(data);
    }

    pub fn resync(&mut self, screen: &str) {
        if self.closed {
            return;
        }
        self.spill.lose(&self.screen);
        self.resume_after(&format!("{MODES_RESET}{screen}"));
    }

    pub fn restore(&mut self, history: &str, hold: bool) {
        if self.closed || history.is_empty() {
            return;
        }
        if hold {
            self.spill.hold();
        }
        self.resume_after(history);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if self.closed || cols < 1 || rows < 1 {
            return;
        }
        if cols == self.target_cols && rows == self.target_rows {
            return;
        }
        self.target_cols = cols;
        self.target_rows = rows;
        self.screen.resize(cols, rows);
    }

    pub fn tail(&self) -> Vec<String> {
        if self.closed {
            Vec::new()
        } else {
            self.spill.tail(&self.screen)
        }
    }

    pub fn pending_end(&self, seq: u64) -> Option<BlockEnd> {
        if self.closed {
            None
        } else {
            self.spill.pending_end(&self.screen, seq)
        }
    }

    pub fn close(&mut self) -> u64 {
        let seq_end = self.spill.seq_end();
        if self.closed {
            return seq_end;
        }
        self.closed = true;
        self.spill.finish(&self.screen);
        self.spill.dispose();
        seq_end
    }

    fn resume_after(&mut self, text: &str) {
        self.feed(format!("{text}\r\n").as_bytes());
        let line = self
            .screen
            .track_active_row(i64::try_from(self.screen.cursor_y()).unwrap_or(0))
            .and_then(|marker| self.screen.marker_line(&marker));
        if let Some(line) = line {
            self.spill
                .resume_at(&self.screen, i64::try_from(line).unwrap_or(0));
        }
    }

    fn flush_to(&mut self, data: &[u8], written: &mut usize, end: usize) {
        if end <= *written {
            return;
        }
        self.screen.write_raw(&data[*written..end]);
        *written = end;
        self.after_chunk();
    }

    fn after_chunk(&mut self) {
        self.spill.check(&self.screen);
    }

    fn feed(&mut self, data: &[u8]) {
        let mut written = 0usize;
        let mut lines = 0usize;
        for (index, &byte) in data.iter().enumerate() {
            match self.observer.step(byte) {
                Some(Sequence::Csi {
                    prefix,
                    intermediates,
                    final_byte,
                    params,
                }) => {
                    if self.watches_csi(&prefix, &intermediates, final_byte) {
                        self.flush_to(data, &mut written, index);
                        self.on_csi(&prefix, final_byte, &params);
                    }
                }
                Some(Sequence::Osc(content)) => {
                    if written < index + 1 {
                        self.screen.write_raw(&data[written..=index]);
                        written = index + 1;
                    }
                    self.on_osc(&content);
                }
                None => {}
            }
            if byte == LINE_FEED {
                lines += 1;
                if lines.is_multiple_of(LINES_PER_SLICE) {
                    self.flush_to(data, &mut written, index + 1);
                }
            }
        }
        self.flush_to(data, &mut written, data.len());
    }

    fn watches_csi(&self, prefix: &str, intermediates: &str, final_byte: u8) -> bool {
        intermediates.is_empty()
            && matches!((prefix, final_byte), ("?", b'h') | ("?", b'l') | ("", b'J'))
    }

    fn on_csi(&mut self, prefix: &str, final_byte: u8, params: &str) {
        match (prefix, final_byte) {
            ("?", b'h') => {
                if any_alternate_screen_mode(params) {
                    self.spill.on_alternate_screen_set(&self.screen);
                }
            }
            ("?", b'l') => {
                if any_alternate_screen_mode(params) {
                    self.spill.on_alternate_screen_reset();
                }
            }
            ("", b'J') if first_param(params) == 3.0 => {
                self.spill.on_clear_scrollback(&self.screen);
            }
            _ => {}
        }
    }

    fn on_osc(&mut self, content: &str) {
        let (ident, data) = match content.split_once(';') {
            Some((ident, data)) => (ident, data),
            None => (content, ""),
        };
        let number = js_number(ident);
        if number == 133.0 {
            self.spill.on_prompt_mark(&self.screen, data);
        } else if number == 633.0 {
            self.spill.on_command_line(data);
        }
    }
}
