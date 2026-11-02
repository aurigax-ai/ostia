#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::relative_time::{
    RelativeStep, RelativeTimeFormat, RelativeUnit, format_relative,
};

const MINUTE: f64 = 60.0;
const HOUR: f64 = 3_600.0;
const DAY: f64 = 86_400.0;

const STEPS: [RelativeStep; 7] = [
    (RelativeUnit::Year, 31_536_000.0),
    (RelativeUnit::Month, 2_592_000.0),
    (RelativeUnit::Week, 604_800.0),
    (RelativeUnit::Day, 86_400.0),
    (RelativeUnit::Hour, 3_600.0),
    (RelativeUnit::Minute, 60.0),
    (RelativeUnit::Second, 1.0),
];

fn en() -> RelativeTimeFormat {
    RelativeTimeFormat::new("en")
}

fn ago(seconds: f64) -> String {
    format_relative(-seconds, &STEPS, &en()).unwrap()
}

#[test]
fn counts_in_the_first_step_the_difference_reaches() {
    assert_eq!(ago(MINUTE), "1 minute ago");
    assert_eq!(ago(89.0 * MINUTE), "1 hour ago");
    assert_eq!(ago(23.0 * HOUR), "23 hours ago");
    assert_eq!(ago(24.0 * HOUR), "yesterday");
    assert_eq!(ago(6.0 * DAY), "6 days ago");
    assert_eq!(ago(7.0 * DAY), "last week");
    assert_eq!(ago(29.0 * DAY), "4 weeks ago");
    assert_eq!(ago(30.0 * DAY), "last month");
    assert_eq!(ago(364.0 * DAY), "12 months ago");
    assert_eq!(ago(365.0 * DAY), "last year");
}

#[test]
fn counts_in_the_last_step_when_the_difference_reaches_none() {
    assert_eq!(ago(59.0), "59 seconds ago");
    assert_eq!(ago(0.6), "1 second ago");
    assert_eq!(ago(0.4), "now");
    assert_eq!(ago(0.0), "now");
    let minutes = [(RelativeUnit::Minute, 60.0)];
    assert_eq!(
        format_relative(-45.0, &minutes, &en()).unwrap(),
        "1 minute ago"
    );
    assert_eq!(
        format_relative(-20.0, &minutes, &en()).unwrap(),
        "this minute"
    );
}

#[test]
fn formats_a_time_ahead_of_now() {
    assert_eq!(
        format_relative(45.0, &STEPS, &en()).unwrap(),
        "in 45 seconds"
    );
    assert_eq!(
        format_relative(2.0 * HOUR, &STEPS, &en()).unwrap(),
        "in 2 hours"
    );
    assert_eq!(format_relative(DAY, &STEPS, &en()).unwrap(), "tomorrow");
}

#[test]
fn writes_in_the_language_of_the_formatter_it_is_given() {
    let zh_hant = RelativeTimeFormat::new("zh-Hant");
    assert_eq!(format_relative(-45.0, &STEPS, &zh_hant).unwrap(), "45 秒前");
    assert_eq!(format_relative(-DAY, &STEPS, &zh_hant).unwrap(), "昨天");
    assert_eq!(
        format_relative(2.0 * HOUR, &STEPS, &zh_hant).unwrap(),
        "2 小時後"
    );
}

#[test]
fn refuses_a_difference_that_is_not_a_number_like_the_formatter_itself() {
    assert!(format_relative(f64::NAN, &STEPS, &en()).is_err());
}

#[test]
fn takes_the_first_matching_step_in_the_order_given_not_the_largest() {
    let small_first = [(RelativeUnit::Second, 1.0), (RelativeUnit::Hour, 3_600.0)];
    assert_eq!(
        format_relative(-2.0 * HOUR, &small_first, &en()).unwrap(),
        "7,200 seconds ago"
    );
}

#[test]
fn rounds_half_toward_positive_infinity_like_math_round() {
    let seconds = [(RelativeUnit::Second, 1.0)];
    assert_eq!(
        format_relative(1.5, &seconds, &en()).unwrap(),
        "in 2 seconds"
    );
    assert_eq!(
        format_relative(-1.5, &seconds, &en()).unwrap(),
        "1 second ago"
    );
    assert_eq!(
        format_relative(-2.5, &seconds, &en()).unwrap(),
        "2 seconds ago"
    );
    assert_eq!(
        format_relative(2.5, &seconds, &en()).unwrap(),
        "in 3 seconds"
    );
}
