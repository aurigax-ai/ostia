#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::claude_accounts::{AccountUsage, UsageWindow};
use ostia_model::agents::usage_line::{UsageLineStrings, is_stale, usage_line_parts, weekly_pace};

const MIN: i64 = 60_000;
const DAY: i64 = 24 * 60 * MIN;
const NOW: i64 = 1_792_756_800_000;
const UTC: i32 = 0;

fn strings() -> UsageLineStrings {
    UsageLineStrings {
        usage_session: "Session {percent}%".to_owned(),
        usage_weekly: "Weekly {percent}%".to_owned(),
        usage_pace: "pace {percent}%".to_owned(),
        usage_resets: "resets {when}".to_owned(),
    }
}

fn window(percent: f64, resets_at: i64) -> UsageWindow {
    UsageWindow { percent, resets_at }
}

fn usage(
    session: Option<UsageWindow>,
    weekly: Option<UsageWindow>,
    checked_at: i64,
) -> AccountUsage {
    AccountUsage {
        session,
        weekly,
        checked_at,
    }
}

#[test]
fn names_session_weekly_the_share_of_the_week_gone_and_the_weekly_reset_day() {
    let usage = usage(
        Some(window(41.6, NOW + 60 * MIN)),
        Some(window(18.2, NOW + 4 * DAY)),
        NOW,
    );
    assert_eq!(
        usage_line_parts(&usage, NOW, "en-US", UTC, &strings()),
        ["Session 42%", "Weekly 18%", "pace 43%", "resets Tue"]
    );
}

#[test]
fn names_the_hour_when_the_week_resets_within_a_day() {
    let usage = usage(None, Some(window(90.0, NOW + 3 * 60 * MIN)), NOW);
    assert_eq!(
        usage_line_parts(&usage, NOW, "en-US", UTC, &strings()),
        ["Weekly 90%", "pace 98%", "resets 3:00 PM"]
    );
}

#[test]
fn shows_a_window_whose_reset_passed_as_empty_without_a_pace_or_reset_for_it() {
    let usage = usage(
        Some(window(80.0, NOW - 1)),
        Some(window(50.0, NOW - 1)),
        NOW - DAY,
    );
    assert_eq!(
        usage_line_parts(&usage, NOW, "en-US", UTC, &strings()),
        ["Session 0%", "Weekly 0%"]
    );
}

#[test]
fn leaves_out_a_window_the_answer_did_not_carry() {
    assert!(usage_line_parts(&usage(None, None, NOW), NOW, "en-US", UTC, &strings()).is_empty());
}

#[test]
fn names_the_reset_in_the_zone_offset_it_is_given() {
    let usage = usage(None, Some(window(90.0, NOW + 3 * 60 * MIN)), NOW);
    assert_eq!(
        usage_line_parts(&usage, NOW, "en-US", -5 * 3600, &strings()),
        ["Weekly 90%", "pace 98%", "resets 10:00 AM"]
    );
}

#[test]
fn is_the_share_of_the_seven_days_already_gone() {
    assert_eq!(weekly_pace(&window(0.0, NOW + 7 * DAY), NOW), 0);
    assert_eq!(weekly_pace(&window(0.0, NOW + 7 * DAY / 2), NOW), 50);
    assert_eq!(weekly_pace(&window(0.0, NOW + 8 * DAY), NOW), 0);
}

#[test]
fn marks_an_answer_older_than_half_an_hour() {
    assert!(!is_stale(&usage(None, None, NOW - 30 * MIN), NOW));
    assert!(is_stale(&usage(None, None, NOW - 31 * MIN), NOW));
}

#[test]
fn rounds_a_percent_just_below_half_down() {
    let usage = usage(
        Some(window(0.499_999_999_999_999_94, NOW + 60 * MIN)),
        None,
        NOW,
    );
    assert_eq!(
        usage_line_parts(&usage, NOW, "en", UTC, &strings()),
        ["Session 0%"]
    );
}
