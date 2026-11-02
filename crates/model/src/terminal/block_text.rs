use ostia_base::js::{is_js_space, js_trim};

pub trait BufferLine {
    fn is_wrapped(&self) -> bool;
    fn translate_to_string(
        &self,
        trim_right: bool,
        start_col: usize,
        end_col: Option<usize>,
    ) -> String;
}

pub trait BufferLike {
    type Line: BufferLine;

    fn get_line(&self, y: i64) -> Option<Self::Line>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellPos {
    pub line: i64,
    pub col: usize,
}

pub fn read_buffer_text<B: BufferLike>(buf: &B, from: CellPos, to: CellPos) -> String {
    if from.line < 0 || to.line < 0 {
        return String::new();
    }
    let last_line = if to.col > 0 { to.line } else { to.line - 1 };
    let mut logical: Vec<String> = Vec::new();
    for y in from.line..=last_line {
        let Some(line) = buf.get_line(y) else {
            break;
        };
        let start_col = if y == from.line { from.col } else { 0 };
        let end_col = (y == to.line).then_some(to.col);
        let wraps_into_next = y < last_line && buf.get_line(y + 1).is_some_and(|l| l.is_wrapped());
        let segment = line.translate_to_string(!wraps_into_next, start_col, end_col);
        match logical.last_mut() {
            Some(last) if y != from.line && line.is_wrapped() => last.push_str(&segment),
            _ => logical.push(segment),
        }
    }
    let mut trimmed: Vec<&str> = logical
        .iter()
        .map(|l| l.trim_end_matches(is_js_space))
        .collect();
    while trimmed.last().is_some_and(|l| l.is_empty()) {
        trimmed.pop();
    }
    trimmed.join("\n")
}

pub fn read_command_text<B: BufferLike>(buf: &B, input: CellPos, start: CellPos) -> String {
    js_trim(&read_buffer_text(buf, input, start)).to_owned()
}
