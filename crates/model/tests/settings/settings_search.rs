#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::settings::settings_search::{HighlightPart, highlight_parts, matches_query};

fn part(text: &str, at: usize, is_match: bool) -> HighlightPart {
    HighlightPart {
        text: text.to_owned(),
        at,
        is_match,
    }
}

#[test]
fn matches_any_of_the_texts_ignoring_case_and_surrounding_spaces() {
    assert!(matches_query(
        &[Some("Cursor style"), Some("Blink the cursor")],
        "  BLINK "
    ));
    assert!(!matches_query(&[Some("Cursor style")], "font"));
}

#[test]
fn never_matches_an_empty_query_or_a_missing_text() {
    assert!(!matches_query(&[Some("Cursor style")], "   "));
    assert!(!matches_query(&[None, None, Some("")], "a"));
}

#[test]
fn treats_regular_expression_characters_in_the_query_as_plain_text() {
    assert!(matches_query(&[Some("Lines (max)")], "(max)"));
    assert!(!matches_query(&[Some("Lines max")], "(max)"));
    assert!(!matches_query(&[Some("anything")], ".*"));
    assert!(matches_query(&[Some("a.*b")], ".*"));
}

#[test]
fn matches_text_in_another_script() {
    assert!(matches_query(&[Some("游標樣式")], "游標"));
}

#[test]
fn splits_every_occurrence_out_as_a_match_keeping_the_original_case() {
    assert_eq!(
        highlight_parts("Font and font size", "FONT"),
        vec![
            part("Font", 0, true),
            part(" and ", 4, false),
            part("font", 9, true),
            part(" size", 13, false),
        ]
    );
}

#[test]
fn returns_the_whole_text_unmarked_when_nothing_matches_or_the_query_is_empty() {
    assert_eq!(
        highlight_parts("Zoom", "font"),
        vec![part("Zoom", 0, false)]
    );
    assert_eq!(highlight_parts("Zoom", ""), vec![part("Zoom", 0, false)]);
    assert_eq!(highlight_parts("", "font"), Vec::<HighlightPart>::new());
}

#[test]
fn escapes_the_query_instead_of_running_it_as_a_pattern() {
    assert_eq!(
        highlight_parts("a+b and ab", "a+b"),
        vec![part("a+b", 0, true), part(" and ab", 3, false)]
    );
}

#[test]
fn marks_every_match_when_the_same_query_was_just_tested() {
    assert!(matches_query(&[Some("Cursor blink")], "blink"));
    assert_eq!(
        highlight_parts("Cursor blink", "blink"),
        vec![part("Cursor ", 0, false), part("blink", 7, true)]
    );
}

#[test]
fn counts_the_position_of_a_match_in_utf16_units() {
    assert_eq!(
        highlight_parts("😀 font", "font"),
        vec![part("😀 ", 0, false), part("font", 3, true)]
    );
}

#[test]
fn trims_the_query_before_it_marks_matches() {
    assert_eq!(
        highlight_parts("Font", "  font  "),
        vec![part("Font", 0, true)]
    );
    assert_eq!(highlight_parts("a b", " "), vec![part("a b", 0, false)]);
}

#[test]
fn finds_matches_that_touch_each_other_and_the_text_edges() {
    assert_eq!(
        highlight_parts("abab", "ab"),
        vec![part("ab", 0, true), part("ab", 2, true)]
    );
}

#[test]
fn does_not_overlap_matches() {
    assert_eq!(
        highlight_parts("aaa", "aa"),
        vec![part("aa", 0, true), part("a", 2, false)]
    );
}
