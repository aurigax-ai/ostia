#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::workspace_groups::{
    WORKSPACE_GROUP_COLORS, is_workspace_group_color, normalize_group_name,
};
use serde_json::{Value, json};

fn name(raw: Value) -> Option<String> {
    normalize_group_name(&raw)
}

#[test]
fn lists_the_eight_group_colors_in_order() {
    assert_eq!(
        WORKSPACE_GROUP_COLORS,
        [
            "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"
        ]
    );
}

#[test]
fn accepts_each_group_color() {
    for color in WORKSPACE_GROUP_COLORS {
        assert!(is_workspace_group_color(&json!(color)), "row {color}");
    }
}

#[test]
fn refuses_a_value_that_is_not_a_group_color() {
    let rows = [
        json!("Red"),
        json!("RED"),
        json!(" red"),
        json!("red "),
        json!("brown"),
        json!(""),
        json!(null),
        json!(0),
        json!(true),
        json!(["red"]),
        json!({"red": true}),
    ];
    for row in rows {
        assert!(!is_workspace_group_color(&row), "row {row}");
    }
}

#[test]
fn trims_a_group_name() {
    assert_eq!(name(json!("  Work \t\n")), Some("Work".to_owned()));
}

#[test]
fn keeps_the_text_inside_a_group_name() {
    assert_eq!(name(json!("a  b\tc")), Some("a  b\tc".to_owned()));
}

#[test]
fn gives_no_group_name_for_a_value_that_is_not_a_string() {
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
        assert_eq!(name(row.clone()), None, "row {row}");
    }
}

#[test]
fn gives_no_group_name_for_an_empty_or_blank_string() {
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
        assert_eq!(name(json!(row)), None, "row {row:?}");
    }
}

#[test]
fn trims_the_javascript_space_set_from_a_group_name() {
    assert_eq!(
        name(json!("\u{feff}\u{a0}Work\u{2003}\u{3000}")),
        Some("Work".to_owned())
    );
}

#[test]
fn does_not_trim_next_line_from_a_group_name() {
    assert_eq!(
        name(json!("\u{85}Work\u{85}")),
        Some("\u{85}Work\u{85}".to_owned())
    );
}

#[test]
fn keeps_a_group_name_of_exactly_sixty_units() {
    let text = "a".repeat(60);
    assert_eq!(name(json!(text.clone())), Some(text));
}

#[test]
fn cuts_a_group_name_to_sixty_units() {
    let text = "a".repeat(61);
    assert_eq!(name(json!(text)), Some("a".repeat(60)));
}

#[test]
fn cuts_a_group_name_by_utf16_units_not_bytes() {
    let text = "é".repeat(70);
    assert_eq!(name(json!(text)), Some("é".repeat(60)));
    let text = "日".repeat(70);
    assert_eq!(name(json!(text)), Some("日".repeat(60)));
}

#[test]
fn counts_a_pair_of_units_as_two_when_it_cuts_a_group_name() {
    let text = format!("{}😀tail", "a".repeat(58));
    assert_eq!(name(json!(text)), Some(format!("{}😀", "a".repeat(58))));
}

#[test]
fn trims_the_text_before_it_cuts_a_group_name() {
    let text = format!("   {}", "a".repeat(70));
    assert_eq!(name(json!(text)), Some("a".repeat(60)));
}

#[test]
fn trims_again_after_it_cuts_a_group_name() {
    let text = format!("{} {}", "a".repeat(59), "b".repeat(10));
    assert_eq!(name(json!(text)), Some("a".repeat(59)));
}

#[test]
fn keeps_the_text_when_space_surrounds_it_before_and_after_the_cut() {
    let text = format!("{}x", " ".repeat(59));
    assert_eq!(name(json!(text)), Some("x".to_owned()));
    let text = format!("x{}", " ".repeat(80));
    assert_eq!(name(json!(text)), Some("x".to_owned()));
}
