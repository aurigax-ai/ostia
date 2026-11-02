#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::scrollback_history::{
    DEFAULT_SCROLLBACK_HISTORY, HistoryBlockRange, HistoryMatch, HistoryPage, HistorySearchOptions,
    HistorySearchResult, SCROLLBACK_HISTORY_MAX_MIB, SCROLLBACK_HISTORY_MIN_MIB, ScrollbackHistory,
    parse_scrollback_history,
};
use serde_json::{Value, json};

fn parsed(raw: Value) -> Value {
    serde_json::to_value(parse_scrollback_history(&raw)).unwrap()
}

#[test]
fn exposes_the_limits_and_the_unlimited_default() {
    assert_eq!(SCROLLBACK_HISTORY_MIN_MIB, 64);
    assert_eq!(SCROLLBACK_HISTORY_MAX_MIB, 1_048_576);
    assert_eq!(DEFAULT_SCROLLBACK_HISTORY, ScrollbackHistory::Unlimited);
}

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
    assert_eq!(parsed(json!("off")), json!("off"));
    assert_eq!(parsed(json!("unlimited")), json!("unlimited"));
}

#[test]
fn falls_back_to_the_default_for_anything_that_is_not_a_number_or_a_keyword() {
    let rows = [
        json!(null),
        json!("256"),
        json!("OFF"),
        json!(""),
        json!(true),
        json!([]),
        json!({}),
        json!([128]),
    ];
    for raw in rows {
        assert_eq!(
            parse_scrollback_history(&raw),
            DEFAULT_SCROLLBACK_HISTORY,
            "{raw}"
        );
    }
}

#[test]
fn keeps_a_number_inside_the_limits() {
    for mib in [64, 65, 512, 1_048_575, 1_048_576] {
        assert_eq!(parsed(json!(mib)), json!(mib), "{mib}");
    }
}

#[test]
fn clamps_a_number_outside_the_limits() {
    let rows = [
        (json!(0), 64),
        (json!(1), 64),
        (json!(63), 64),
        (json!(-5), 64),
        (json!(-1.0e300), 64),
        (json!(1_048_577), 1_048_576),
        (json!(1.0e300), 1_048_576),
    ];
    for (raw, expected) in rows {
        assert_eq!(parsed(raw.clone()), json!(expected), "{raw}");
    }
}

#[test]
fn rounds_a_fraction_as_math_round_does() {
    let rows = [
        (json!(100.4), 100),
        (json!(100.5), 101),
        (json!(100.6), 101),
        (json!(64.5), 65),
        (json!(63.5), 64),
        (json!(63.4), 64),
        (json!(1_048_575.5), 1_048_576),
    ];
    for (raw, expected) in rows {
        assert_eq!(parsed(raw.clone()), json!(expected), "{raw}");
    }
}

#[test]
fn writes_a_size_as_an_integer_number() {
    assert_eq!(
        serde_json::to_string(&parse_scrollback_history(&json!(100.0))).unwrap(),
        "100"
    );
}

#[test]
fn writes_a_history_page_in_field_order() {
    let page = HistoryPage {
        first: 3,
        end: 9,
        from: 5,
        lines: vec!["a".to_owned(), "b".to_owned()],
    };
    assert_eq!(
        serde_json::to_string(&page).unwrap(),
        r#"{"first":3,"end":9,"from":5,"lines":["a","b"]}"#
    );
}

#[test]
fn leaves_out_the_search_options_that_are_unset() {
    assert_eq!(
        serde_json::to_string(&HistorySearchOptions::default()).unwrap(),
        "{}"
    );
    let options: HistorySearchOptions =
        serde_json::from_value(json!({"caseSensitive": true, "wholeWord": false})).unwrap();
    assert_eq!(options.case_sensitive, Some(true));
    assert_eq!(options.regex, None);
    assert_eq!(options.whole_word, Some(false));
}

#[test]
fn writes_a_search_result_and_a_block_range() {
    let result = HistorySearchResult {
        count: 2,
        matches: vec![HistoryMatch {
            line: 4,
            start: 1,
            end: 3,
        }],
    };
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({"count": 2, "matches": [{"line": 4, "start": 1, "end": 3}]})
    );
    assert_eq!(
        serde_json::to_value(HistoryBlockRange { start: 7, end: 12 }).unwrap(),
        json!({"start": 7, "end": 12})
    );
}
