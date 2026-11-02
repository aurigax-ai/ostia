#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::workspace_text::normalize_description;
use serde_json::{Value, json};

fn description(raw: Value) -> Option<String> {
    normalize_description(&raw)
}

#[test]
fn trims_a_description() {
    assert_eq!(
        description(json!("  Build the thing \n")),
        Some("Build the thing".to_owned())
    );
}

#[test]
fn keeps_the_text_inside_a_description() {
    assert_eq!(
        description(json!("line one\n\nline  two\ttab")),
        Some("line one\n\nline  two\ttab".to_owned())
    );
}

#[test]
fn gives_no_description_for_a_value_that_is_not_a_string() {
    let rows = [
        json!(null),
        json!(5),
        json!(0),
        json!(true),
        json!(false),
        json!(["a"]),
        json!({"a": 1}),
    ];
    for row in rows {
        assert_eq!(description(row.clone()), None, "row {row}");
    }
}

#[test]
fn gives_no_description_for_an_empty_or_blank_string() {
    let rows = [
        "",
        " ",
        "\t\n\r",
        "\u{a0}",
        "\u{feff}",
        "\u{2028}\u{2029}",
        "\u{3000}\u{2003}",
    ];
    for row in rows {
        assert_eq!(description(json!(row)), None, "row {row:?}");
    }
}

#[test]
fn trims_the_javascript_space_set_from_a_description() {
    assert_eq!(
        description(json!("\u{feff}\u{a0}Work\u{2003}\u{3000}")),
        Some("Work".to_owned())
    );
}

#[test]
fn does_not_trim_next_line_from_a_description() {
    assert_eq!(
        description(json!("\u{85}Work\u{85}")),
        Some("\u{85}Work\u{85}".to_owned())
    );
}

#[test]
fn keeps_a_description_of_exactly_five_hundred_units() {
    let text = "a".repeat(500);
    assert_eq!(description(json!(text.clone())), Some(text));
}

#[test]
fn cuts_a_long_description_to_four_hundred_ninety_nine_units_and_an_ellipsis() {
    let text = "a".repeat(501);
    assert_eq!(
        description(json!(text)),
        Some(format!("{}…", "a".repeat(499)))
    );
}

#[test]
fn cuts_a_description_by_utf16_units_not_bytes() {
    let text = "é".repeat(600);
    assert_eq!(
        description(json!(text)),
        Some(format!("{}…", "é".repeat(499)))
    );
    let text = "日".repeat(500);
    assert_eq!(description(json!(text.clone())), Some(text));
}

#[test]
fn counts_a_pair_of_units_as_two_when_it_cuts_a_description() {
    let text = format!("{}😀tail{}", "a".repeat(497), "b".repeat(100));
    assert_eq!(
        description(json!(text)),
        Some(format!("{}😀…", "a".repeat(497)))
    );
}

#[test]
fn trims_the_text_before_it_measures_a_description() {
    let text = format!("  {}  ", "a".repeat(500));
    assert_eq!(description(json!(text)), Some("a".repeat(500)));
}

#[test]
fn does_not_trim_again_before_the_ellipsis_of_a_description() {
    let text = format!("{} {}", "a".repeat(498), "b".repeat(50));
    assert_eq!(
        description(json!(text)),
        Some(format!("{} …", "a".repeat(498)))
    );
}
