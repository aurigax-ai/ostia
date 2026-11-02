#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::finished_hibernate::{
    DEFAULT_FINISHED_HIBERNATE_MINUTES, finished_hibernate_minutes,
};
use serde_json::{Value, json};

fn minutes(raw: Value) -> i64 {
    finished_hibernate_minutes(Some(&raw))
}

#[test]
fn falls_back_to_ten_minutes_for_a_missing_null_or_non_numeric_value() {
    assert_eq!(DEFAULT_FINISHED_HIBERNATE_MINUTES, 10);
    assert_eq!(finished_hibernate_minutes(None), 10);
    for raw in [
        json!(null),
        json!("abc"),
        json!("12abc"),
        json!({}),
        json!([1, 2]),
        json!("Infinity"),
        json!("-Infinity"),
    ] {
        assert_eq!(minutes(raw.clone()), 10, "{raw}");
    }
}

#[test]
fn rounds_a_number_and_keeps_it_between_zero_and_one_day() {
    for (raw, expected) in [
        (json!(0), 0),
        (json!(1), 1),
        (json!(5), 5),
        (json!(2.4), 2),
        (json!(2.5), 3),
        (json!(0.5), 1),
        (json!(0.4), 0),
        (json!(-0.4), 0),
        (json!(-5), 0),
        (json!(1440), 1440),
        (json!(1441), 1440),
        (json!(1e9), 1440),
        (json!(1e300), 1440),
    ] {
        assert_eq!(minutes(raw.clone()), expected, "{raw}");
    }
}

#[test]
fn reads_a_value_the_way_number_does() {
    for (raw, expected) in [
        (json!("15"), 15),
        (json!("  7  "), 7),
        (json!("2.5"), 3),
        (json!("0x10"), 16),
        (json!("1e2"), 100),
        (json!(""), 0),
        (json!("   "), 0),
        (json!(true), 1),
        (json!(false), 0),
        (json!([]), 0),
        (json!("-3"), 0),
        (json!("5000"), 1440),
    ] {
        assert_eq!(minutes(raw.clone()), expected, "{raw}");
    }
}
