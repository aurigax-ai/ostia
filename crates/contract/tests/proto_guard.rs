#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::proto_guard::is_dangerous_segment;

#[test]
fn flags() {
    for segment in ["__proto__", "prototype", "constructor"] {
        assert!(is_dangerous_segment(segment), "{segment}");
    }
}

#[test]
fn is_case_sensitive_does_not_flag_a_differently_cased_lookalike() {
    assert!(!is_dangerous_segment("__PROTO__"));
    assert!(!is_dangerous_segment("Constructor"));
}

#[test]
fn does_not_flag_an_ordinary_key() {
    assert!(!is_dangerous_segment("theme"));
    assert!(!is_dangerous_segment(""));
}

#[test]
fn does_not_flag_a_segment_that_only_contains_a_dangerous_word() {
    for segment in [
        "__proto__x",
        " prototype",
        "constructor ",
        "my.constructor",
        "proto",
    ] {
        assert!(!is_dangerous_segment(segment), "{segment:?}");
    }
}
