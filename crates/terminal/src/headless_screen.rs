use libghostty_vt::fmt::Format;
use libghostty_vt::screen::{Screen, TrackedGridRef};
use libghostty_vt::selection::{FormatOptions, Selection};
use libghostty_vt::terminal::{Point, PointCoordinate, PointSpace};
use libghostty_vt::{Terminal, TerminalOptions};
use ostia_base::js::js_trim;

pub struct Marker {
    tracked: TrackedGridRef,
}

pub struct HeadlessScreen {
    term: Terminal<'static, 'static>,
    cols: u16,
    rows: u16,
}

impl HeadlessScreen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Result<Self, String> {
        let term = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: scrollback,
        })
        .map_err(|err| err.to_string())?;
        Ok(Self { term, cols, rows })
    }

    pub fn write_raw(&mut self, bytes: &[u8]) {
        self.term.vt_write(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        if self.term.resize(cols, rows, 1, 1).is_ok() {
            self.cols = cols;
            self.rows = rows;
        }
    }

    pub fn is_normal(&self) -> bool {
        matches!(self.term.active_screen(), Ok(Screen::Primary))
    }

    pub fn base_y(&self) -> usize {
        self.term.scrollback_rows().unwrap_or(0)
    }

    pub fn total_rows(&self) -> usize {
        self.term.total_rows().unwrap_or(0)
    }

    pub fn cursor_x(&self) -> usize {
        usize::from(self.term.cursor_x().unwrap_or(0))
    }

    pub fn cursor_y(&self) -> usize {
        usize::from(self.term.cursor_y().unwrap_or(0))
    }

    pub fn track_active_row(&self, y: i64) -> Option<Marker> {
        if y < 0 || y >= i64::from(self.rows) {
            return None;
        }
        let row = u32::try_from(y).ok()?;
        let tracked = self
            .term
            .track_grid_ref(Point::Active(PointCoordinate { x: 0, y: row }))
            .ok()?;
        Some(Marker { tracked })
    }

    pub fn marker_line(&self, marker: &Marker) -> Option<usize> {
        let point = marker.tracked.point(PointSpace::Screen).ok()??;
        usize::try_from(point.y).ok()
    }

    pub fn row_is_continuation(&self, y: usize) -> bool {
        let Ok(row) = u32::try_from(y) else {
            return false;
        };
        self.term
            .grid_ref(Point::Screen(PointCoordinate { x: 0, y: row }))
            .ok()
            .and_then(|grid| grid.row().ok())
            .and_then(|row| row.is_wrap_continuation().ok())
            .unwrap_or(false)
    }

    pub fn row_is_blank(&self, y: usize) -> bool {
        js_trim(&self.format_rows(y, y, Format::Plain)).is_empty()
    }

    pub fn last_content_row(&self) -> i64 {
        let mut last = i64::try_from(self.total_rows()).unwrap_or(i64::MAX) - 1;
        while last >= 0 && self.row_is_blank(usize::try_from(last).unwrap_or(0)) {
            last -= 1;
        }
        last
    }

    fn format_rows(&self, from: usize, to: usize, format: Format) -> String {
        let (Ok(from_row), Ok(to_row)) = (u32::try_from(from), u32::try_from(to)) else {
            return String::new();
        };
        let last_col = self.cols.saturating_sub(1);
        let Ok(start) = self
            .term
            .grid_ref(Point::Screen(PointCoordinate { x: 0, y: from_row }))
        else {
            return String::new();
        };
        let Ok(end) = self.term.grid_ref(Point::Screen(PointCoordinate {
            x: last_col,
            y: to_row,
        })) else {
            return String::new();
        };
        let selection = Selection::new(start, end, false);
        let options = FormatOptions::new()
            .with_emit_format(format)
            .with_unwrap(true)
            .with_trim(true)
            .with_selection(&selection);
        match self.term.format_selection_alloc(None, options) {
            Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => String::new(),
        }
    }

    pub fn serialize(&self, from: usize, to: usize) -> Vec<String> {
        if to < from {
            return Vec::new();
        }
        let text = normalize_vt(&self.format_rows(from, to, Format::Vt));
        let printed: Vec<&str> = if text.is_empty() {
            Vec::new()
        } else {
            text.split("\r\n").collect()
        };
        let mut starts = vec![from];
        for y in from + 1..=to {
            if !self.row_is_continuation(y) {
                starts.push(y);
            }
        }
        let mut lines = Vec::with_capacity(starts.len());
        let mut at = 0usize;
        for (index, &start) in starts.iter().enumerate() {
            let rows = starts.get(index + 1).copied().unwrap_or(to + 1) - start;
            let mut blank = 0usize;
            while blank + 1 < rows
                && self
                    .format_rows(start + blank, start + blank, Format::Vt)
                    .is_empty()
            {
                blank += 1;
            }
            at += blank;
            let row_text = printed.get(at).copied().unwrap_or("");
            at += 1;
            let mut line = " ".repeat(blank * usize::from(self.cols));
            line.push_str(row_text);
            lines.push(line);
        }
        lines
    }
}

const PALETTE_PREFIX: &str = "\x1b]4;";
const STRING_TERMINATOR: &str = "\x1b\\";
const RESET: &str = "\x1b[0m";

fn trailing_pen(text: &str) -> Option<usize> {
    let start = text.rfind("\x1b[")?;
    let body = text[start + 2..].strip_suffix('m')?;
    let is_pen = !body.is_empty()
        && body != "0"
        && body
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == ';' || ch == ':');
    is_pen.then_some(start)
}

fn normalize_vt(text: &str) -> String {
    let mut rest = text;
    while rest.starts_with(PALETTE_PREFIX) {
        match rest.find(STRING_TERMINATOR) {
            Some(end) => rest = &rest[end + STRING_TERMINATOR.len()..],
            None => break,
        }
    }
    let mut out = rest.to_string();
    while let Some(start) = trailing_pen(&out) {
        out.truncate(start);
    }
    if out.ends_with(RESET) {
        out.truncate(out.len() - RESET.len());
    }
    out
}
