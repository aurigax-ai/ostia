use ostia_model::files::mermaid_image::{MERMAID_SOURCE_MAX, check_mermaid_source};

#[test]
fn accepts_a_source_at_the_limit() {
    assert!(check_mermaid_source(&"x".repeat(MERMAID_SOURCE_MAX)).is_ok());
}

#[test]
fn refuses_a_source_too_large_to_draw() {
    let error = check_mermaid_source(&"x".repeat(MERMAID_SOURCE_MAX + 1)).unwrap_err();
    assert!(error.to_string().contains("too large"));
}

#[test]
fn counts_the_length_in_utf16_units_like_the_ts_source() {
    let astral = "\u{1F600}".repeat(MERMAID_SOURCE_MAX / 2 + 1);
    assert!(check_mermaid_source(&astral).is_err());
    let at_limit = "\u{1F600}".repeat(MERMAID_SOURCE_MAX / 2);
    assert!(check_mermaid_source(&at_limit).is_ok());
}

#[test]
fn the_source_limit_is_fifty_thousand() {
    assert_eq!(MERMAID_SOURCE_MAX, 50_000);
}
