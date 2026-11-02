#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_cli::common::line_field::{line_field, tsv_line};
use serde_json::{Value, json};

#[test]
fn keeps_one_line_with_one_tab_per_field_whatever_the_free_text_holds() {
    let line = tsv_line(&[
        json!("p1"),
        json!("fix\ttabs\nand lines\r"),
        json!("bell\u{7}esc\u{1b}[0m"),
        json!("del\u{7f}"),
    ]);
    assert_eq!(
        line,
        "p1\tfix\\ttabs\\nand lines\\r\tbell\\x07esc\\x1b[0m\tdel\\x7f"
    );
    assert_eq!(line.split('\n').count(), 1);
    assert_eq!(line.split('\t').count(), 4);
}

#[test]
fn escapes_c1_controls_reordering_controls_and_line_separators() {
    assert_eq!(
        line_field(&json!("a\u{9b}b\u{202e}c\u{2066}d\u{61c}e\u{2028}f")),
        "a\\x9bb\\u202ec\\u2066d\\u061ce\\u2028f"
    );
}

#[test]
fn keeps_cjk_persian_with_zwnj_hebrew_with_rlm_and_a_zwj_emoji_as_they_are() {
    for text in [
        "控制面板.md",
        "می\u{200c}خواهم.txt",
        "שלום\u{200f}.md",
        "👨\u{200d}💻 dev",
    ] {
        assert_eq!(line_field(&json!(text)), text);
    }
}

#[test]
fn prints_a_missing_field_as_empty_and_leaves_other_text_alone() {
    assert_eq!(line_field(&Value::Null), "");
    assert_eq!(line_field(&json!("控制面 ✓ a\\b")), "控制面 ✓ a\\b");
}

#[test]
fn prints_numbers_and_booleans_the_way_javascript_prints_them() {
    assert_eq!(line_field(&json!(5)), "5");
    assert_eq!(line_field(&json!(1.5)), "1.5");
    assert_eq!(line_field(&json!(true)), "true");
    assert_eq!(line_field(&json!(false)), "false");
}

#[test]
fn escapes_the_edges_of_each_control_and_hidden_range() {
    for (text, escaped) in [
        ("\u{0}", "\\x00"),
        ("\u{1f}", "\\x1f"),
        (" ", " "),
        ("\u{7e}", "~"),
        ("\u{80}", "\\x80"),
        ("\u{9f}", "\\x9f"),
        ("\u{a0}", "\u{a0}"),
        ("\u{2027}", "\u{2027}"),
        ("\u{2029}", "\\u2029"),
        ("\u{202a}", "\\u202a"),
        ("\u{202f}", "\u{202f}"),
        ("\u{2065}", "\u{2065}"),
        ("\u{2069}", "\\u2069"),
        ("\u{206a}", "\u{206a}"),
        ("\u{61b}", "\u{61b}"),
    ] {
        assert_eq!(line_field(&json!(text)), escaped, "{text:?}");
    }
}

#[test]
fn joins_no_fields_to_an_empty_line_and_one_field_without_a_tab() {
    assert_eq!(tsv_line(&[]), "");
    assert_eq!(tsv_line(&[json!("only")]), "only");
    assert_eq!(tsv_line(&[Value::Null, json!("b")]), "\tb");
}
