use std::sync::Arc;

use ostia_base::js::js_number;

use crate::headless_screen::{HeadlessScreen, Marker};

pub const SPILL_BATCH: usize = 500;
pub const GAP_LINE: &str = "\x1b[2m── earlier lines not kept ──\x1b[0m";

pub trait SpillSink: Send + Sync {
    fn end(&self) -> u64;
    fn live(&self) -> bool;
    fn append(&self, lines: &[String]);
    fn block_started(&self, seq: u64, start: u64, command: Option<&str>);
    fn block_ended(&self, seq: u64, end: u64, end_col: u64, exit_code: i32, command: Option<&str>);
    fn wipe(&self);
    fn flush(&self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockEnd {
    pub line: u64,
    pub end_col: u64,
    pub exit_code: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkKind {
    Start,
    End,
}

struct PendingMark {
    kind: MarkKind,
    seq: u64,
    marker: Marker,
    end_col: usize,
    exit_code: i32,
    command: Option<String>,
}

pub fn decode_command_line(encoded: &str) -> String {
    let chars: Vec<char> = encoded.chars().collect();
    let mut out = String::with_capacity(encoded.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '\\' {
            match chars.get(index + 1) {
                Some('\\') => {
                    out.push('\\');
                    index += 2;
                    continue;
                }
                Some('x') => {
                    let hex: String = chars.iter().skip(index + 2).take(2).collect();
                    if hex.chars().count() == 2
                        && hex.chars().all(|c| c.is_ascii_hexdigit())
                        && let Some(decoded) = u8::from_str_radix(&hex, 16).ok().map(char::from)
                    {
                        out.push(decoded);
                        index += 4;
                        continue;
                    }
                }
                _ => {}
            }
        }
        out.push(ch);
        index += 1;
    }
    out
}

pub struct HistorySpill {
    history: Arc<dyn SpillSink>,
    frontier: Option<Marker>,
    held: bool,
    alt_tail: Option<Vec<String>>,
    alt_ends: Option<Vec<(u64, BlockEnd)>>,
    finished: bool,
    marks: Vec<PendingMark>,
    seq: u64,
    running: Option<u64>,
    command: Option<String>,
}

fn to_row(line: i64) -> usize {
    usize::try_from(line).unwrap_or(0)
}

impl HistorySpill {
    pub fn new(screen: &HeadlessScreen, history: Arc<dyn SpillSink>, seq_offset: u64) -> Self {
        let mut spill = Self {
            history,
            frontier: None,
            held: false,
            alt_tail: None,
            alt_ends: None,
            finished: false,
            marks: Vec::new(),
            seq: seq_offset,
            running: None,
            command: None,
        };
        spill.frontier = spill.marker_at(screen, 0);
        spill
    }

    pub fn seq_end(&self) -> u64 {
        self.seq
    }

    pub fn hold(&mut self) {
        self.held = true;
    }

    pub fn resume_at(&mut self, screen: &HeadlessScreen, line: i64) {
        if !self.held || self.finished {
            return;
        }
        self.held = false;
        self.frontier = None;
        self.frontier = self.marker_at(screen, line);
        self.check(screen);
    }

    pub fn tail(&self, screen: &HeadlessScreen) -> Vec<String> {
        if self.held || self.finished {
            return Vec::new();
        }
        let Some(line) = self
            .frontier
            .as_ref()
            .and_then(|marker| screen.marker_line(marker))
        else {
            return Vec::new();
        };
        if !screen.is_normal() {
            return self.alt_tail.clone().unwrap_or_default();
        }
        let last = screen.last_content_row();
        if last < i64::try_from(line).unwrap_or(i64::MAX) {
            Vec::new()
        } else {
            screen.serialize(line, to_row(last))
        }
    }

    pub fn lose(&mut self, screen: &HeadlessScreen) {
        if self.finished {
            return;
        }
        if !self.held && screen.is_normal() {
            self.spill(screen, screen.last_content_row(), true);
        }
        if self.history.live() {
            self.history.append(&[GAP_LINE.to_string()]);
        }
        self.marks.clear();
        self.frontier = None;
        self.held = true;
    }

    pub fn finish(&mut self, screen: &HeadlessScreen) {
        if self.finished {
            return;
        }
        if !self.held && screen.is_normal() {
            self.spill(screen, screen.last_content_row(), true);
        }
        self.finished = true;
        self.history.flush();
    }

    pub fn dispose(&mut self) {
        self.marks.clear();
        self.frontier = None;
    }

    pub fn check(&mut self, screen: &HeadlessScreen) {
        if self.held || self.finished || !screen.is_normal() {
            return;
        }
        if !self.history.live() {
            return;
        }
        let frontier = self.frontier_line(screen);
        let base_y = i64::try_from(screen.base_y()).unwrap_or(i64::MAX);
        let batch = i64::try_from(SPILL_BATCH).unwrap_or(i64::MAX);
        if base_y - frontier >= batch {
            self.spill(screen, base_y - 1, false);
        }
    }

    pub fn pending_end(&self, screen: &HeadlessScreen, seq: u64) -> Option<BlockEnd> {
        if !screen.is_normal() {
            return self
                .alt_ends
                .as_ref()
                .and_then(|ends| ends.iter().find(|(found, _)| *found == seq))
                .map(|(_, end)| *end);
        }
        self.live_pending_end(screen, seq)
    }

    fn live_pending_end(&self, screen: &HeadlessScreen, seq: u64) -> Option<BlockEnd> {
        let frontier = self
            .frontier
            .as_ref()
            .and_then(|marker| screen.marker_line(marker))?;
        let (mark, row) = self.marks.iter().find_map(|mark| {
            if mark.kind == MarkKind::End && mark.seq == seq {
                screen.marker_line(&mark.marker).map(|row| (mark, row))
            } else {
                None
            }
        })?;
        Some(BlockEnd {
            line: self.logical_line(screen, frontier, row, self.history.end()),
            end_col: u64::try_from(mark.end_col).unwrap_or(u64::MAX),
            exit_code: mark.exit_code,
        })
    }

    pub fn on_prompt_mark(&mut self, screen: &HeadlessScreen, data: &str) {
        let mut parts = data.split(';');
        let kind = parts.next().unwrap_or("");
        let arg = parts.next();
        if kind == "A" {
            self.command = None;
            return;
        }
        let mark_kind = match kind {
            "C" => MarkKind::Start,
            "D" => MarkKind::End,
            _ => return,
        };
        if mark_kind == MarkKind::Start {
            self.seq += 1;
            self.running = Some(self.seq);
        }
        let seq = if mark_kind == MarkKind::Start {
            Some(self.seq)
        } else {
            self.running
        };
        if mark_kind == MarkKind::End {
            self.running = None;
        }
        let Some(seq) = seq else {
            return;
        };
        if self.finished || !screen.is_normal() {
            return;
        }
        let Some(marker) = screen.track_active_row(i64::try_from(screen.cursor_y()).unwrap_or(0))
        else {
            return;
        };
        let exit = arg.map_or(0.0, js_number);
        let exit_code = if exit.is_nan() { 0 } else { exit as i32 };
        self.marks.push(PendingMark {
            kind: mark_kind,
            seq,
            marker,
            end_col: screen.cursor_x(),
            exit_code,
            command: self.command.clone(),
        });
    }

    pub fn on_command_line(&mut self, data: &str) {
        if let Some(rest) = data.strip_prefix("E;") {
            self.command = Some(decode_command_line(rest.split(';').next().unwrap_or("")));
        }
    }

    pub fn on_alternate_screen_set(&mut self, screen: &HeadlessScreen) {
        if screen.is_normal() {
            let ends = self
                .marks
                .iter()
                .filter(|mark| mark.kind == MarkKind::End)
                .filter_map(|mark| {
                    self.live_pending_end(screen, mark.seq)
                        .map(|end| (mark.seq, end))
                })
                .collect();
            self.alt_ends = Some(ends);
        }
        self.alt_tail = Some(self.tail(screen));
    }

    pub fn on_alternate_screen_reset(&mut self) {
        self.alt_tail = None;
        self.alt_ends = None;
    }

    pub fn on_clear_scrollback(&mut self, screen: &HeadlessScreen) {
        if !screen.is_normal() || self.finished {
            return;
        }
        self.marks.clear();
        self.history.wipe();
        self.frontier = None;
        let base_y = i64::try_from(screen.base_y()).unwrap_or(0);
        self.frontier = self.marker_at(screen, base_y);
    }

    fn marker_at(&self, screen: &HeadlessScreen, line: i64) -> Option<Marker> {
        if !screen.is_normal() {
            return None;
        }
        let base_y = i64::try_from(screen.base_y()).unwrap_or(0);
        screen.track_active_row(line - base_y)
    }

    fn frontier_line(&mut self, screen: &HeadlessScreen) -> i64 {
        if let Some(line) = self
            .frontier
            .as_ref()
            .and_then(|marker| screen.marker_line(marker))
        {
            return i64::try_from(line).unwrap_or(i64::MAX);
        }
        self.history.append(&[GAP_LINE.to_string()]);
        self.frontier = self.marker_at(screen, 0);
        0
    }

    fn spill(&mut self, screen: &HeadlessScreen, last_row: i64, whole: bool) {
        if !self.history.live() {
            return;
        }
        let from = self.frontier_line(screen);
        let mut last = last_row;
        if !whole {
            while last >= from && screen.row_is_continuation(to_row(last + 1)) {
                last -= 1;
            }
        }
        if last < from {
            return;
        }
        let first_line = self.history.end();
        let lines = screen.serialize(to_row(from), to_row(last));
        self.history.append(&lines);
        self.record_marks(screen, from, last, first_line);
        self.frontier = None;
        self.frontier = if whole {
            None
        } else {
            self.marker_at(screen, last + 1)
        };
    }

    fn logical_line(
        &self,
        screen: &HeadlessScreen,
        from: usize,
        row: usize,
        first_line: u64,
    ) -> u64 {
        let mut logical = first_line;
        for y in from + 1..=row {
            if !screen.row_is_continuation(y) {
                logical += 1;
            }
        }
        logical
    }

    fn record_marks(&mut self, screen: &HeadlessScreen, from: i64, last: i64, first_line: u64) {
        let mut kept = Vec::new();
        for mark in std::mem::take(&mut self.marks) {
            let row = screen
                .marker_line(&mark.marker)
                .and_then(|line| i64::try_from(line).ok())
                .unwrap_or(-1);
            if row > last {
                kept.push(mark);
                continue;
            }
            if row < from {
                continue;
            }
            let logical = self.logical_line(screen, to_row(from), to_row(row), first_line);
            match mark.kind {
                MarkKind::Start => {
                    self.history
                        .block_started(mark.seq, logical, mark.command.as_deref());
                }
                MarkKind::End => self.history.block_ended(
                    mark.seq,
                    logical,
                    u64::try_from(mark.end_col).unwrap_or(u64::MAX),
                    mark.exit_code,
                    mark.command.as_deref(),
                ),
            }
        }
        self.marks = kept;
    }
}
