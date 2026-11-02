#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_workspaces::primary_selection::{PRIMARY_SELECTION_MAX_CHARS, accepts_primary_selection};
use serde_json::{Value, json};

fn text(len: usize) -> Value {
    json!("x".repeat(len))
}

#[test]
fn accepts_primary_selection_takes_non_empty_text_up_to_the_cap_only_on_linux() {
    assert!(accepts_primary_selection("linux", &json!("ls -la")));
    assert!(!accepts_primary_selection("darwin", &json!("ls -la")));
    assert!(!accepts_primary_selection("linux", &json!("")));
    assert!(!accepts_primary_selection("linux", &json!(42)));
    assert!(!accepts_primary_selection(
        "linux",
        &text(PRIMARY_SELECTION_MAX_CHARS + 1)
    ));
}

#[test]
fn the_primary_selection_takes_only_non_empty_text_up_to_the_cap_from_the_page() {
    let cap = PRIMARY_SELECTION_MAX_CHARS;
    assert!(!accepts_primary_selection("linux", &json!("")));
    assert!(accepts_primary_selection("linux", &text(cap)));
    assert!(!accepts_primary_selection("linux", &text(2 * 1024 * 1024)));
    assert!(accepts_primary_selection("linux", &json!("from-the-page")));
}

#[test]
fn counts_the_cap_in_utf16_units_as_ts_does() {
    let cap = PRIMARY_SELECTION_MAX_CHARS;
    let wide = "😀".repeat(cap / 2);
    assert!(accepts_primary_selection("linux", &json!(wide)));
    let over = format!("{wide}x");
    assert!(!accepts_primary_selection("linux", &json!(over)));
}

#[test]
fn rejects_every_value_that_is_not_text() {
    for value in [json!(null), json!(true), json!([]), json!({}), json!(1.5)] {
        assert!(!accepts_primary_selection("linux", &value), "{value}");
    }
}
