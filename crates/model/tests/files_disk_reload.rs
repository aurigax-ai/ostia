#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::files::disk_reload::{
    ChangedLines, LineEdit, LineRange, changed_lines, minimal_line_edit,
};

fn apply(text: &str, edit: Option<LineEdit>) -> String {
    let Some(edit) = edit else {
        return text.to_owned();
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let lines: Vec<Vec<u16>> = text
        .split('\n')
        .map(|line| line.encode_utf16().collect())
        .collect();
    let offset = |line: usize, column: usize| -> usize {
        let before: usize = lines[..line - 1].iter().map(|l| l.len() + 1).sum();
        before + column - 1
    };
    let start = offset(edit.range.start_line_number, edit.range.start_column);
    let end = offset(edit.range.end_line_number, edit.range.end_column);
    let mut out: Vec<u16> = units[..start].to_vec();
    out.extend(edit.text.encode_utf16());
    out.extend_from_slice(&units[end..]);
    String::from_utf16(&out).unwrap()
}

fn range(start_line: usize, start_col: usize, end_line: usize, end_col: usize) -> LineRange {
    LineRange {
        start_line_number: start_line,
        start_column: start_col,
        end_line_number: end_line,
        end_column: end_col,
    }
}

#[test]
fn replaces_only_the_lines_that_differ() {
    let cases = [
        ("a\nb\nc", "a\nB\nc"),
        ("a\nb\nc", "a\nb\nc\nd"),
        ("a\nb\nc", "z\na\nb\nc"),
        ("a\nb\nc", "a\nc"),
        ("a\nb\nc", ""),
        ("", "x\ny"),
        ("a\nb", "a\nb\n"),
    ];
    for (from, to) in cases {
        assert_eq!(
            apply(from, minimal_line_edit(from, to)),
            to,
            "{from:?} to {to:?}"
        );
    }
    assert_eq!(minimal_line_edit("same", "same"), None);
    let edit = minimal_line_edit("a\nb\nc", "a\nB\nc").unwrap();
    assert_eq!(edit.range.start_line_number, 2);
    assert_eq!(edit.range.end_line_number, 2);
}

#[test]
fn a_changed_middle_line_is_replaced_from_its_first_column_to_its_end() {
    let edit = minimal_line_edit("a\nbb\nc", "a\nB\nc").unwrap();
    assert_eq!(edit.range, range(2, 1, 2, 3));
    assert_eq!(edit.text, "B");
}

#[test]
fn removing_a_middle_line_deletes_through_the_start_of_the_next_line() {
    let edit = minimal_line_edit("a\nb\nc", "a\nc").unwrap();
    assert_eq!(edit.range, range(2, 1, 3, 1));
    assert_eq!(edit.text, "");
}

#[test]
fn removing_the_last_line_deletes_from_the_end_of_the_line_before() {
    let edit = minimal_line_edit("a\nb\nc", "a\nb").unwrap();
    assert_eq!(edit.range, range(2, 2, 3, 2));
    assert_eq!(edit.text, "");
}

#[test]
fn removing_every_line_replaces_the_whole_text() {
    let edit = minimal_line_edit("a\nb\nc", "").unwrap();
    assert_eq!(edit.range, range(1, 1, 3, 2));
    assert_eq!(edit.text, "");
}

#[test]
fn adding_lines_at_the_end_inserts_after_the_last_column() {
    let edit = minimal_line_edit("a\nb\nc", "a\nb\nc\nd").unwrap();
    assert_eq!(edit.range, range(3, 2, 3, 2));
    assert_eq!(edit.text, "\nd");
}

#[test]
fn adding_a_line_at_the_top_inserts_at_the_start() {
    let edit = minimal_line_edit("a\nb\nc", "z\na\nb\nc").unwrap();
    assert_eq!(edit.range, range(1, 1, 1, 1));
    assert_eq!(edit.text, "z\n");
}

#[test]
fn columns_count_utf16_units() {
    let edit = minimal_line_edit("\u{1F600}\nb", "\u{1F600}\nc").unwrap();
    assert_eq!(edit.range, range(2, 1, 2, 2));
    let edit = minimal_line_edit("a\n\u{1F600}\u{1F600}\nc", "a\nx\nc").unwrap();
    assert_eq!(edit.range, range(2, 1, 2, 5));
    let edit = minimal_line_edit("\u{1F600}\n\u{1F600}", "\u{1F600}").unwrap();
    assert_eq!(edit.range, range(1, 3, 2, 3));
    assert_eq!(apply("\u{1F600}\n\u{1F600}", Some(edit)), "\u{1F600}");
}

#[test]
fn an_edit_of_wide_text_applies_to_the_new_text() {
    let cases = [
        ("\u{1F600} a\nb", "\u{1F600} a\nb\n\u{1F600}"),
        ("é\n文\nz", "é\n文文\nz"),
        ("x", "x\n"),
        ("\n", ""),
        ("", "\n"),
    ];
    for (from, to) in cases {
        assert_eq!(
            apply(from, minimal_line_edit(from, to)),
            to,
            "{from:?} to {to:?}"
        );
    }
}

#[test]
fn changed_lines_is_none_for_equal_text() {
    assert_eq!(changed_lines("a\nb", "a\nb"), None);
}

#[test]
fn changed_lines_names_the_new_lines_that_differ() {
    assert_eq!(
        changed_lines("a\nb\nc", "a\nB\nc"),
        Some(ChangedLines { start: 2, end: 2 })
    );
    assert_eq!(
        changed_lines("a\nb\nc", "a\nb\nc\nd"),
        Some(ChangedLines { start: 4, end: 4 })
    );
    assert_eq!(
        changed_lines("a\nb\nc", "z\na\nb\nc"),
        Some(ChangedLines { start: 1, end: 1 })
    );
    assert_eq!(
        changed_lines("", "x\ny"),
        Some(ChangedLines { start: 1, end: 2 })
    );
    assert_eq!(
        changed_lines("a\nb\nc", ""),
        Some(ChangedLines { start: 1, end: 1 })
    );
}

#[test]
fn changed_lines_is_none_when_lines_were_only_removed() {
    assert_eq!(changed_lines("a\nb\nc", "a\nc"), None);
    assert_eq!(changed_lines("a\nb\nc", "a\nb"), None);
}
