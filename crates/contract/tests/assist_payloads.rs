#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::assist_payloads::{SHORT_MAX, optional_short};
use serde_json::json;

#[test]
fn optional_short_trims_and_clips_a_string() {
    assert_eq!(
        optional_short(Some(&json!("  hello  ")), SHORT_MAX),
        Some("hello".to_owned())
    );
    assert_eq!(
        optional_short(Some(&json!("abcdef")), 3),
        Some("abc".to_owned())
    );
    let long = "x".repeat(SHORT_MAX + 50);
    assert_eq!(
        optional_short(Some(&json!(long)), SHORT_MAX).unwrap().len(),
        SHORT_MAX
    );
}

#[test]
fn optional_short_is_none_for_blank_text_and_for_a_value_that_is_not_a_string() {
    assert_eq!(optional_short(Some(&json!("")), SHORT_MAX), None);
    assert_eq!(optional_short(Some(&json!(" \n\t ")), SHORT_MAX), None);
    assert_eq!(optional_short(Some(&json!(3)), SHORT_MAX), None);
    assert_eq!(optional_short(Some(&json!(null)), SHORT_MAX), None);
    assert_eq!(optional_short(None, SHORT_MAX), None);
}

#[test]
fn optional_short_clips_in_utf16_units() {
    assert_eq!(
        optional_short(Some(&json!("😀😀")), 2),
        Some("😀".to_owned())
    );
}

#[test]
fn optional_short_drops_only_the_partial_surrogate_pair_and_keeps_the_rest() {
    assert_eq!(
        optional_short(Some(&json!("ab😀")), 3),
        Some("ab".to_owned())
    );
    assert_eq!(
        optional_short(Some(&json!("ab😀cd")), 4),
        Some("ab".to_owned())
    );
    assert_eq!(optional_short(Some(&json!("😀")), 1), None);
}
