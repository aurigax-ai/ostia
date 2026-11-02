use std::future::Future;
use std::sync::Arc;

use ostia_base::js::js_number;
use ostia_contract::osc7::{CwdReport, parse_osc7};
use parking_lot::Mutex;

use crate::headless_screen::{HeadlessScreen, Marker};
use crate::history_feed::HistoryFeed;
use crate::spill_host::BlockEnd;
use crate::vt_observer::{Observer, Sequence, any_alternate_screen_mode};

const MIRROR_SCROLLBACK: usize = 2500;
pub const HISTORY_LINES: usize = 1000;
const PROMPT_START: &str = "A";
const COMMAND_START: &str = "C";

fn seam(label: &str) -> String {
    format!("\x1b]133;D\x07\r\n\x1b[2m── {label} ──\x1b[0m\r\n")
}

pub fn restore_seam(restored_label: &str) -> String {
    seam(restored_label)
}

pub fn hibernate_seam(woke_label: &str) -> String {
    seam(woke_label)
}

struct Untouched {
    history: String,
    seam_end: Marker,
    prompted: bool,
}

struct Serialized {
    at: u64,
    text: String,
}

pub struct ScreenMirror {
    prompt_start: Option<Marker>,
    untouched: Option<Untouched>,
    screen: HeadlessScreen,
    observer: Observer,
    prompt_start_col: usize,
    disposed: bool,
    target_cols: u16,
    target_rows: u16,
    changes: u64,
    serialized: Option<Serialized>,
    reported_cwd: Option<CwdReport>,
    history_walks: usize,
    feed: Option<HistoryFeed>,
    feed_screen: Option<Arc<Mutex<String>>>,
    block_seq_base: u64,
}

impl ScreenMirror {
    pub fn new(cols: u16, rows: u16, feed: Option<HistoryFeed>) -> Result<Self, String> {
        let target_cols = cols.max(1);
        let target_rows = rows.max(1);
        let screen = HeadlessScreen::new(target_cols, target_rows, MIRROR_SCROLLBACK)?;
        let block_seq_base = feed.as_ref().map_or(0, HistoryFeed::seq_base);
        let feed_screen = feed.as_ref().map(|feed| {
            let latest = Arc::new(Mutex::new(String::new()));
            let reader = Arc::clone(&latest);
            feed.watch_screen(Arc::new(move || reader.lock().clone()));
            latest
        });
        Ok(Self {
            prompt_start: None,
            untouched: None,
            screen,
            observer: Observer::new(),
            prompt_start_col: 0,
            disposed: false,
            target_cols,
            target_rows,
            changes: 0,
            serialized: None,
            reported_cwd: None,
            history_walks: 0,
            feed,
            feed_screen,
            block_seq_base,
        })
    }

    pub fn cwd_report(&self) -> Option<CwdReport> {
        self.reported_cwd.clone()
    }

    pub fn revision(&self) -> u64 {
        self.changes
    }

    pub fn history_walks(&self) -> usize {
        self.history_walks
    }

    pub fn block_seq_base(&self) -> u64 {
        self.block_seq_base
    }

    pub fn cols(&self) -> u16 {
        self.screen.cols()
    }

    pub fn rows(&self) -> u16 {
        self.screen.rows()
    }

    pub fn bracketed_paste(&self) -> bool {
        !self.disposed && self.screen.bracketed_paste()
    }

    pub fn write(&mut self, data: &str) {
        if self.disposed || data.is_empty() {
            return;
        }
        self.parse(data.as_bytes());
        if let Some(feed) = &self.feed {
            feed.write(data);
        }
        self.publish();
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if self.disposed || cols < 1 || rows < 1 {
            return;
        }
        if cols == self.target_cols && rows == self.target_rows {
            return;
        }
        self.target_cols = cols;
        self.target_rows = rows;
        if let Some(feed) = &self.feed {
            feed.resize(cols, rows);
        }
        self.screen.resize(cols, rows);
        self.changes += 1;
        self.publish();
    }

    pub fn restore(&mut self, history: &str) {
        if self.disposed || history.is_empty() {
            return;
        }
        if let Some(feed) = &self.feed {
            feed.restore(history);
        }
        self.parse(format!("{history}\r\n").as_bytes());
        self.clear_untouched();
        if let Some(seam_end) = self.cursor_marker() {
            self.untouched = Some(Untouched {
                history: history.to_owned(),
                seam_end,
                prompted: false,
            });
        }
        self.publish();
    }

    pub fn pending_block_end(
        &self,
        seq: u64,
    ) -> impl Future<Output = Option<BlockEnd>> + Send + use<> {
        let pending = if self.disposed {
            None
        } else {
            self.feed.as_ref().map(|feed| feed.pending_end(seq))
        };
        async move {
            match pending {
                Some(pending) => pending.await,
                None => None,
            }
        }
    }

    pub fn history_tail(&self) -> impl Future<Output = Vec<String>> + Send + use<> {
        let tail = if self.disposed {
            None
        } else {
            self.feed.as_ref().map(HistoryFeed::tail)
        };
        async move {
            match tail {
                Some(tail) => tail.await,
                None => Vec::new(),
            }
        }
    }

    pub fn serialize(&mut self) -> String {
        if self.disposed {
            return String::new();
        }
        if !self.screen.is_normal() {
            return self
                .serialized
                .as_ref()
                .map(|serialized| serialized.text.clone())
                .unwrap_or_default();
        }
        if let Some(serialized) = &self.serialized
            && serialized.at == self.changes
        {
            return serialized.text.clone();
        }
        let text = self.serialize_history();
        self.serialized = Some(Serialized {
            at: self.changes,
            text: text.clone(),
        });
        text
    }

    pub fn screen_text(&self, max_lines: usize) -> String {
        if self.disposed || max_lines < 1 {
            return String::new();
        }
        let mut end = self.last_row();
        while end >= 0 && self.blank(end) {
            end -= 1;
        }
        let mut lines: Vec<String> = Vec::new();
        let mut y = end;
        while y >= 0 && lines.len() < max_lines {
            let mut text = String::new();
            while y > 0 && self.wrapped(y) {
                text = format!("{}{text}", self.row(y));
                y -= 1;
            }
            lines.push(format!("{}{text}", self.row(y)));
            y -= 1;
        }
        lines.reverse();
        lines.join("\n")
    }

    pub fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        if let Some(feed) = &self.feed {
            drop(feed.close());
        }
        self.clear_prompt_start();
        self.clear_untouched();
    }

    fn publish(&mut self) {
        let Some(latest) = self.feed_screen.clone() else {
            return;
        };
        let text = self.serialize();
        *latest.lock() = text;
    }

    fn parse(&mut self, data: &[u8]) {
        let mut written = 0;
        for (index, &byte) in data.iter().enumerate() {
            match self.observer.step(byte) {
                Some(Sequence::Csi {
                    prefix,
                    intermediates,
                    final_byte,
                    params,
                }) => {
                    if prefix == "?" && intermediates.is_empty() && final_byte == b'h' {
                        self.write_through(data, &mut written, index);
                        if any_alternate_screen_mode(&params) {
                            let text = self.serialize_history();
                            self.serialized = Some(Serialized {
                                at: self.changes,
                                text,
                            });
                        }
                    }
                }
                Some(Sequence::Osc(content)) => {
                    self.write_through(data, &mut written, index + 1);
                    self.on_osc(&content);
                }
                None => {}
            }
        }
        self.write_through(data, &mut written, data.len());
        self.changes += 1;
    }

    fn write_through(&mut self, data: &[u8], written: &mut usize, end: usize) {
        if end > *written {
            self.screen.write_raw(&data[*written..end]);
            *written = end;
        }
    }

    fn on_osc(&mut self, content: &str) {
        let (ident, data) = content.split_once(';').unwrap_or((content, ""));
        let number = js_number(ident);
        if number == 133.0 {
            self.on_prompt_mark(data.split(';').next().unwrap_or(""));
        } else if number == 7.0
            && let Some(report) = parse_osc7(data)
        {
            self.reported_cwd = Some(report);
        }
    }

    fn on_prompt_mark(&mut self, kind: &str) {
        if !self.screen.is_normal() {
            return;
        }
        if kind == PROMPT_START {
            self.clear_prompt_start();
            self.prompt_start = self.cursor_marker();
            self.prompt_start_col = self.screen.cursor_x();
            self.skip_startup_output();
        } else if kind == COMMAND_START {
            self.clear_prompt_start();
            self.clear_untouched();
        }
    }

    fn skip_startup_output(&mut self) {
        let Some(untouched) = &self.untouched else {
            return;
        };
        if untouched.prompted {
            return;
        }
        let Some(first_prompt) = self.cursor_marker() else {
            return;
        };
        if let Some(untouched) = &mut self.untouched {
            untouched.seam_end = first_prompt;
            untouched.prompted = true;
        }
    }

    fn cursor_marker(&self) -> Option<Marker> {
        let y = i64::try_from(self.screen.cursor_y()).ok()?;
        self.screen.track_active_row(y)
    }

    fn clear_untouched(&mut self) {
        self.untouched = None;
    }

    fn clear_prompt_start(&mut self) {
        self.prompt_start = None;
    }

    fn last_row(&self) -> i64 {
        i64::try_from(self.screen.total_rows()).unwrap_or(i64::MAX) - 1
    }

    fn row(&self, y: i64) -> String {
        usize::try_from(y).map_or_else(|_| String::new(), |y| self.screen.row_text(y))
    }

    fn blank(&self, y: i64) -> bool {
        usize::try_from(y).is_ok_and(|y| self.screen.row_is_blank(y))
    }

    fn wrapped(&self, y: i64) -> bool {
        usize::try_from(y).is_ok_and(|y| self.screen.row_is_continuation(y))
    }

    fn history_end(&self) -> i64 {
        let mut end = self.last_row();
        if let Some(line) = self
            .prompt_start
            .as_ref()
            .and_then(|mark| self.screen.marker_line(mark))
            .and_then(|line| i64::try_from(line).ok())
        {
            end = if self.prompt_start_col > 0 {
                line
            } else {
                line - 1
            };
        }
        while end >= 0 && self.blank(end) {
            end -= 1;
        }
        end
    }

    fn serialize_history(&mut self) -> String {
        self.history_walks += 1;
        let end = self.history_end();
        if let Some(untouched) = &self.untouched
            && let Some(seam_line) = self
                .screen
                .marker_line(&untouched.seam_end)
                .and_then(|line| i64::try_from(line).ok())
            && end < seam_line
        {
            return untouched.history.clone();
        }
        if end < 0 {
            return String::new();
        }
        let limit = i64::try_from(HISTORY_LINES).unwrap_or(i64::MAX);
        let mut start = (end - limit + 1).max(0);
        while start > 0 && self.wrapped(start) {
            start -= 1;
        }
        while start < end && self.blank(start) && !self.wrapped(start + 1) {
            start += 1;
        }
        match (usize::try_from(start), usize::try_from(end)) {
            (Ok(from), Ok(to)) => self.screen.serialize(from, to).join("\r\n"),
            _ => String::new(),
        }
    }
}

#[cfg(test)]
mod probe {
    use crate::headless_screen::HeadlessScreen;

    #[test]
    fn probe_resize_reflow() {
        let mut screen = HeadlessScreen::new(80, 10, 2500).unwrap();
        screen.write_raw(b"\x1b[70GX\r\n");
        screen.resize(40, 10);
        let mut report = format!(
            "total={} cursor=({},{})\n",
            screen.total_rows(),
            screen.cursor_x(),
            screen.cursor_y()
        );
        for y in 0..4 {
            report.push_str(&format!(
                "row {y}: text={:?} blank={} cont={}\n",
                screen.row_text(y),
                screen.row_is_blank(y),
                screen.row_is_continuation(y)
            ));
        }
        report.push_str(&format!("last={} ser={:?}\n", screen.last_content_row(), screen.serialize(0, 1)));
        panic!("{report}");
    }
}
