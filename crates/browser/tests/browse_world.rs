#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::browse_world::{BROWSE_WORLD_ID, js_args};
use serde_json::{Value, json};

#[test]
fn uses_the_isolated_world_id_the_page_scripts_expect() {
    assert_eq!(BROWSE_WORLD_ID, 1025);
}

#[test]
fn joins_the_arguments_as_json_separated_by_a_comma_and_a_space() {
    assert_eq!(
        js_args(&[json!("a"), json!(2), json!(true), json!({"k": [1, 2]})]),
        r#""a", 2, true, {"k":[1,2]}"#
    );
}

#[test]
fn writes_no_text_for_no_arguments() {
    assert_eq!(js_args(&[]), "");
}

#[test]
fn writes_null_for_a_missing_value() {
    assert_eq!(js_args(&[Value::Null, json!("x")]), r#"null, "x""#);
}

#[test]
fn escapes_quotes_backslashes_and_newlines_so_a_string_stays_one_literal() {
    let text = "a\"b\\c\nd";
    assert_eq!(js_args(&[json!(text)]), r#""a\"b\\c\nd""#);
}
