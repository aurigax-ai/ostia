#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::block_text::{
    BufferLike, BufferLine, CellPos, read_buffer_text, read_command_text,
};

const COLS: usize = 10;

#[derive(Clone)]
struct Row {
    text: String,
    wrapped: bool,
}

struct Buffer(Vec<Row>);

impl BufferLine for Row {
    fn is_wrapped(&self) -> bool {
        self.wrapped
    }

    fn translate_to_string(
        &self,
        trim_right: bool,
        start_col: usize,
        end_col: Option<usize>,
    ) -> String {
        let cells: Vec<char> = format!("{:<COLS$}", self.text).chars().collect();
        let end = end_col.unwrap_or(COLS).min(cells.len());
        let start = start_col.min(end);
        let slice: String = cells[start..end].iter().collect();
        if trim_right {
            slice.trim_end().to_owned()
        } else {
            slice
        }
    }
}

impl BufferLike for Buffer {
    type Line = Row;

    fn get_line(&self, y: i64) -> Option<Row> {
        usize::try_from(y).ok().and_then(|i| self.0.get(i)).cloned()
    }
}

fn plain(text: &str) -> Row {
    Row {
        text: text.to_owned(),
        wrapped: false,
    }
}

fn wrapped(text: &str) -> Row {
    Row {
        text: text.to_owned(),
        wrapped: true,
    }
}

fn at(line: i64, col: usize) -> CellPos {
    CellPos { line, col }
}

#[test]
fn joins_soft_wrapped_rows_into_one_logical_line_without_inserting_a_newline() {
    let buf = Buffer(vec![
        plain("$ ls"),
        plain("abcdefghij"),
        wrapped("klm"),
        plain("next"),
        plain("$ "),
    ]);

    assert_eq!(
        read_buffer_text(&buf, at(1, 0), at(4, 0)),
        "abcdefghijklm\nnext"
    );
}

#[test]
fn keeps_spaces_that_fall_exactly_on_a_wrap_boundary() {
    let buf = Buffer(vec![plain("hello     "), wrapped("world")]);

    assert_eq!(
        read_buffer_text(&buf, at(0, 0), at(2, 0)),
        "hello     world"
    );
}

#[test]
fn strips_trailing_whitespace_per_line_and_drops_trailing_blank_lines() {
    let buf = Buffer(vec![
        plain("one   "),
        plain("two"),
        plain(""),
        plain("   "),
        plain("$ "),
    ]);

    assert_eq!(read_buffer_text(&buf, at(0, 0), at(4, 0)), "one\ntwo");
}

#[test]
fn reads_the_end_row_up_to_its_column_when_output_stops_mid_line() {
    let buf = Buffer(vec![plain("out1"), plain("partial%  ")]);

    assert_eq!(read_buffer_text(&buf, at(0, 0), at(1, 7)), "out1\npartial");
}

#[test]
fn returns_an_empty_string_when_a_marker_was_trimmed_away() {
    let buf = Buffer(vec![plain("x")]);

    assert_eq!(read_buffer_text(&buf, at(-1, 0), at(1, 0)), "");
    assert_eq!(read_buffer_text(&buf, at(0, 0), at(-1, 0)), "");
}

#[test]
fn reads_from_the_input_column_of_the_b_mark_up_to_the_c_mark() {
    let buf = Buffer(vec![plain("~ ❯ echo h"), wrapped("i there"), plain("")]);

    assert_eq!(read_command_text(&buf, at(0, 4), at(2, 0)), "echo hi there");
}

#[test]
fn reads_a_command_that_ends_on_the_c_line_itself() {
    let buf = Buffer(vec![plain("$ ls -la  ")]);

    assert_eq!(read_command_text(&buf, at(0, 2), at(0, 8)), "ls -la");
}
