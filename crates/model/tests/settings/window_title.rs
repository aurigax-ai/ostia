#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::settings::window_title::{
    DEFAULT_WINDOW_TITLE, WINDOW_TITLE_MAX, WindowTitleValues, format_window_title,
    parse_window_title,
};
use serde_json::json;

fn product_only() -> WindowTitleValues {
    WindowTitleValues {
        product: "ostia".to_owned(),
        ..WindowTitleValues::default()
    }
}

#[test]
fn fills_the_placeholders() {
    let values = WindowTitleValues {
        product: "ostia".to_owned(),
        workspace: Some("sonar".to_owned()),
        pane: Some("claude".to_owned()),
        cwd: Some("~/sonar".to_owned()),
    };
    assert_eq!(
        format_window_title("{workspace} — {pane} ({cwd}) · {product}", &values),
        "sonar — claude (~/sonar) · ostia"
    );
}

#[test]
fn drops_separators_left_dangling_by_an_empty_value_and_falls_back_to_the_product() {
    assert_eq!(
        format_window_title(DEFAULT_WINDOW_TITLE, &product_only()),
        "ostia"
    );
    assert_eq!(format_window_title("{workspace}", &product_only()), "ostia");
}

#[test]
fn keeps_a_string_template_and_falls_back_for_anything_else() {
    assert_eq!(parse_window_title(&json!("{pane}")), "{pane}");
    assert_eq!(parse_window_title(&json!(3)), DEFAULT_WINDOW_TITLE);
    assert_eq!(
        parse_window_title(&json!("x".repeat(200))),
        DEFAULT_WINDOW_TITLE
    );
}

#[test]
fn falls_back_for_null_missing_and_non_string_values() {
    for (row, value) in [
        ("null", json!(null)),
        ("bool", json!(true)),
        ("array", json!(["{pane}"])),
        ("object", json!({"a": 1})),
    ] {
        assert_eq!(
            parse_window_title(&value),
            DEFAULT_WINDOW_TITLE,
            "row {row}"
        );
    }
}

#[test]
fn measures_the_template_limit_in_utf16_units() {
    assert_eq!(WINDOW_TITLE_MAX, 120);
    let at_limit = "😀".repeat(60);
    let over_limit = "😀".repeat(61);
    assert_eq!(parse_window_title(&json!(at_limit)), at_limit);
    assert_eq!(parse_window_title(&json!(over_limit)), DEFAULT_WINDOW_TITLE);
    let ascii_limit = "a".repeat(120);
    assert_eq!(parse_window_title(&json!(ascii_limit)), ascii_limit);
    assert_eq!(
        parse_window_title(&json!("a".repeat(121))),
        DEFAULT_WINDOW_TITLE
    );
}

#[test]
fn keeps_an_empty_template_as_a_string() {
    assert_eq!(parse_window_title(&json!("")), "");
}

#[test]
fn trims_every_edge_separator_kind_and_keeps_inner_ones() {
    assert_eq!(
        format_window_title(" ·—–-|: {workspace} · {product} :|-–—· ", &product_only()),
        "ostia"
    );
    let values = WindowTitleValues {
        product: "ostia".to_owned(),
        workspace: Some("sonar".to_owned()),
        ..WindowTitleValues::default()
    };
    assert_eq!(
        format_window_title("-- {workspace} | {pane} | {product} --", &values),
        "sonar |  | ostia"
    );
}

#[test]
fn treats_an_empty_string_value_like_a_missing_one() {
    let values = WindowTitleValues {
        product: "ostia".to_owned(),
        workspace: Some(String::new()),
        pane: Some("claude".to_owned()),
        cwd: None,
    };
    assert_eq!(
        format_window_title("{workspace} · {pane}", &values),
        "claude"
    );
}

#[test]
fn leaves_unknown_placeholders_and_repeats_known_ones() {
    let values = WindowTitleValues {
        product: "ostia".to_owned(),
        pane: Some("p".to_owned()),
        ..WindowTitleValues::default()
    };
    assert_eq!(
        format_window_title("{pane}{pane} {other} {Pane}", &values),
        "pp {other} {Pane}"
    );
}

#[test]
fn trims_the_js_space_set_at_the_edges() {
    assert_eq!(
        format_window_title(
            "\u{feff}{pane}\u{feff}",
            &WindowTitleValues {
                product: "ostia".to_owned(),
                pane: Some("p".to_owned()),
                ..WindowTitleValues::default()
            }
        ),
        "p"
    );
    assert_eq!(
        format_window_title(
            "\u{85}{pane}\u{85}",
            &WindowTitleValues {
                product: "ostia".to_owned(),
                pane: Some("p".to_owned()),
                ..WindowTitleValues::default()
            }
        ),
        "\u{85}p\u{85}"
    );
}
