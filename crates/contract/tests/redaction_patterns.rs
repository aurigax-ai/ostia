#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use ostia_contract::redaction::{compile_patterns, custom_spans, pattern_problem};

fn found_in(pattern: &str, text: &str) -> Vec<String> {
    let regexes = compile_patterns(&[pattern.to_owned()]);
    let until = Instant::now() + Duration::from_secs(5);
    custom_spans(text, &regexes, until)
        .unwrap()
        .iter()
        .map(|span| text[span.start..span.end].to_owned())
        .collect()
}

#[test]
fn reads_a_brace_that_is_not_a_quantifier_as_a_literal_brace() {
    assert_eq!(pattern_problem("key-{x}"), None);
    assert_eq!(found_in("key-{x}", "a key-{x} b"), ["key-{x}"]);
    assert_eq!(found_in("a{,3}", "a{,3} aaa"), ["a{,3}"]);
}

#[test]
fn keeps_a_real_quantifier_a_quantifier() {
    assert_eq!(found_in("ab{2}", "ab abb"), ["abb"]);
}

#[test]
fn reads_double_ampersand_in_a_class_as_two_members() {
    assert_eq!(found_in("[a&&b]", "a&b-c"), ["a", "&", "b"]);
}

#[test]
fn reads_double_tilde_in_a_class_as_two_members() {
    assert_eq!(found_in("[a~~b]", "a~b-c"), ["a", "~", "b"]);
}

#[test]
fn reads_a_bracket_inside_a_class_as_a_member() {
    assert_eq!(found_in("[[x]", "a[x"), ["[", "x"]);
}

#[test]
fn stops_when_the_time_is_up() {
    let regexes = compile_patterns(&["a+b".to_owned()]);
    let until = Instant::now() - Duration::from_millis(1);
    assert!(custom_spans("aab", &regexes, until).is_none());
}
