#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::theme::theme_choice::{MATCH_OSTIA_THEME, is_linked_theme, parse_theme_choice};
use serde_json::json;

#[test]
fn the_linked_choice_is_match() {
    assert_eq!(MATCH_OSTIA_THEME, "match");
}

#[test]
fn a_non_string_value_falls_back_to_match() {
    for raw in [
        json!(null),
        json!(1),
        json!(true),
        json!([]),
        json!(["adeberry"]),
        json!({}),
        json!({"id": "adeberry"}),
    ] {
        assert_eq!(parse_theme_choice(&raw), MATCH_OSTIA_THEME);
    }
}

#[test]
fn an_empty_or_blank_string_falls_back_to_match() {
    for raw in ["", " ", "   ", "\t\n", "\u{a0}"] {
        assert_eq!(parse_theme_choice(&json!(raw)), MATCH_OSTIA_THEME);
    }
}

#[test]
fn a_theme_id_is_kept() {
    assert_eq!(parse_theme_choice(&json!("adeberry")), "adeberry");
    assert_eq!(parse_theme_choice(&json!("ext.theme-1")), "ext.theme-1");
}

#[test]
fn the_match_id_is_kept() {
    assert_eq!(parse_theme_choice(&json!("match")), MATCH_OSTIA_THEME);
}

#[test]
fn surrounding_whitespace_is_trimmed() {
    assert_eq!(parse_theme_choice(&json!("  adeberry\n")), "adeberry");
    assert_eq!(parse_theme_choice(&json!("\tmatch ")), MATCH_OSTIA_THEME);
}

#[test]
fn inner_whitespace_is_kept() {
    assert_eq!(parse_theme_choice(&json!(" my theme ")), "my theme");
}

#[test]
fn an_id_of_80_characters_is_kept() {
    let id = "a".repeat(80);
    assert_eq!(parse_theme_choice(&json!(id)), id);
}

#[test]
fn an_id_of_81_characters_falls_back_to_match() {
    let id = "a".repeat(81);
    assert_eq!(parse_theme_choice(&json!(id)), MATCH_OSTIA_THEME);
}

#[test]
fn the_length_limit_applies_after_trimming() {
    let id = "a".repeat(80);
    assert_eq!(parse_theme_choice(&json!(format!("  {id}  "))), id);
}

#[test]
fn the_length_counts_utf16_units_like_the_ts_string_length() {
    let kept = "😀".repeat(40);
    assert_eq!(parse_theme_choice(&json!(kept)), kept);
    let dropped = "😀".repeat(41);
    assert_eq!(parse_theme_choice(&json!(dropped)), MATCH_OSTIA_THEME);
}

#[test]
fn match_is_a_linked_theme() {
    assert!(is_linked_theme(MATCH_OSTIA_THEME));
    assert!(is_linked_theme("match"));
}

#[test]
fn any_other_choice_is_not_linked() {
    for choice in ["adeberry", "Match", " match", "match ", ""] {
        assert!(!is_linked_theme(choice));
    }
}

#[test]
fn a_parsed_choice_is_linked_only_when_it_fell_back_or_said_match() {
    assert!(is_linked_theme(&parse_theme_choice(&json!(null))));
    assert!(is_linked_theme(&parse_theme_choice(&json!(" match "))));
    assert!(!is_linked_theme(&parse_theme_choice(&json!("adeberry"))));
}
