#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::app_link_settings::{
    AppLinkSettings, app_link_asks, parse_allowed_app_schemes, parse_ask_before_opening_apps,
};
use serde_json::{Value, json};

fn allowed(raw: Value) -> Vec<String> {
    parse_allowed_app_schemes(Some(&raw))
}

#[test]
fn keeps_unique_lower_case_app_schemes() {
    assert_eq!(
        allowed(json!(["Obsidian", "obsidian", "vscode", "chrome"])),
        ["obsidian", "vscode", "chrome"]
    );
}

#[test]
fn drops_blocked_schemes_bad_shapes_and_non_strings() {
    assert!(
        allowed(json!([
            "javascript",
            "file",
            "ms-msdt",
            "devtools",
            "a",
            "x y",
            1,
            null,
            "mailto"
        ]))
        .is_empty()
    );
    assert!(allowed(json!("obsidian")).is_empty());
    assert!(parse_allowed_app_schemes(None).is_empty());
}

#[test]
fn keeps_at_most_one_hundred_schemes() {
    let many: Vec<String> = (0..150).map(|n| format!("ab{n}")).collect();
    let kept = allowed(json!(many));
    assert_eq!(kept.len(), 100);
    assert_eq!(kept[99], "ab99");
}

#[test]
fn asks_unless_the_question_is_off_or_the_scheme_is_allowed() {
    let on = AppLinkSettings {
        ask_before_opening_apps: true,
        allowed_app_schemes: vec!["vscode".to_owned()],
    };
    assert!(app_link_asks(&on, "obsidian"));
    assert!(!app_link_asks(&on, "vscode"));
    let off = AppLinkSettings {
        ask_before_opening_apps: false,
        allowed_app_schemes: vec!["vscode".to_owned()],
    };
    assert!(!app_link_asks(&off, "obsidian"));
}

#[test]
fn treats_anything_but_false_as_on() {
    assert!(parse_ask_before_opening_apps(None));
    assert!(parse_ask_before_opening_apps(Some(&json!("no"))));
    assert!(parse_ask_before_opening_apps(Some(&json!(null))));
    assert!(!parse_ask_before_opening_apps(Some(&json!(false))));
}
