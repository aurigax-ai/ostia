#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::scrollback_history::{
    DEFAULT_SCROLLBACK_HISTORY, SCROLLBACK_HISTORY_MAX_MIB, SCROLLBACK_HISTORY_MIN_MIB,
    ScrollbackHistory, parse_scrollback_history,
};
use serde_json::{Value, json};

#[test]
fn keeps_off_and_unlimited() {
    assert_eq!(
        parse_scrollback_history(&json!("off")),
        ScrollbackHistory::Off
    );
    assert_eq!(
        parse_scrollback_history(&json!("unlimited")),
        ScrollbackHistory::Unlimited
    );
}

#[test]
fn falls_back_to_the_default_for_anything_else() {
    assert_eq!(DEFAULT_SCROLLBACK_HISTORY, ScrollbackHistory::Unlimited);
    let rows: [Value; 6] = [
        json!(null),
        json!("on"),
        json!(true),
        json!([128]),
        json!({}),
        json!("128"),
    ];
    for row in rows {
        assert_eq!(
            parse_scrollback_history(&row),
            DEFAULT_SCROLLBACK_HISTORY,
            "{row}"
        );
    }
}

#[test]
fn rounds_a_size_and_keeps_it_between_the_minimum_and_the_maximum() {
    let rows = [
        (json!(10), SCROLLBACK_HISTORY_MIN_MIB),
        (json!(-5), SCROLLBACK_HISTORY_MIN_MIB),
        (json!(100.4), 100),
        (json!(100.5), 101),
        (json!(2048), 2048),
        (json!(5_000_000_000_u64), SCROLLBACK_HISTORY_MAX_MIB),
    ];
    for (raw, mib) in rows {
        assert_eq!(
            parse_scrollback_history(&raw),
            ScrollbackHistory::Mib(mib),
            "{raw}"
        );
    }
}
