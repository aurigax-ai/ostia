use chrono::{DateTime, Datelike, FixedOffset, Timelike, Weekday};
use ostia_contract::claude_accounts::{AccountUsage, UsageWindow, percent_now};
use ostia_contract::dict::fmt;
use serde_json::json;

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageLineStrings {
    pub usage_session: String,
    pub usage_weekly: String,
    pub usage_pace: String,
    pub usage_resets: String,
}

fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub fn weekly_pace(weekly: &UsageWindow, now: i64) -> i64 {
    if weekly.resets_at <= now {
        return 0;
    }
    let elapsed = WEEK_MS - (weekly.resets_at - now);
    let share = round_half_up(elapsed as f64 / WEEK_MS as f64 * 100.0);
    share.clamp(0.0, 100.0) as i64
}

fn is_chinese(locale: &str) -> bool {
    locale == "zh" || locale.starts_with("zh-")
}

fn weekday_name(weekday: Weekday, chinese: bool) -> &'static str {
    match (weekday, chinese) {
        (Weekday::Mon, false) => "Mon",
        (Weekday::Tue, false) => "Tue",
        (Weekday::Wed, false) => "Wed",
        (Weekday::Thu, false) => "Thu",
        (Weekday::Fri, false) => "Fri",
        (Weekday::Sat, false) => "Sat",
        (Weekday::Sun, false) => "Sun",
        (Weekday::Mon, true) => "週一",
        (Weekday::Tue, true) => "週二",
        (Weekday::Wed, true) => "週三",
        (Weekday::Thu, true) => "週四",
        (Weekday::Fri, true) => "週五",
        (Weekday::Sat, true) => "週六",
        (Weekday::Sun, true) => "週日",
    }
}

fn clock_text(hour: u32, minute: u32, chinese: bool) -> String {
    let twelve = if hour.is_multiple_of(12) {
        12
    } else {
        hour % 12
    };
    if chinese {
        let period = if hour < 12 { "上午" } else { "下午" };
        return format!("{period}{twelve}:{minute:02}");
    }
    let period = if hour < 12 { "AM" } else { "PM" };
    format!("{twelve}:{minute:02} {period}")
}

fn reset_when(resets_at: i64, now: i64, locale: &str, utc_offset_seconds: i32) -> String {
    let (Some(offset), Some(instant)) = (
        FixedOffset::east_opt(utc_offset_seconds),
        DateTime::from_timestamp_millis(resets_at),
    ) else {
        return "Invalid Date".to_owned();
    };
    let local = instant.with_timezone(&offset);
    let chinese = is_chinese(locale);
    if resets_at - now < DAY_MS {
        clock_text(local.hour(), local.minute(), chinese)
    } else {
        weekday_name(local.weekday(), chinese).to_owned()
    }
}

pub fn usage_line_parts(
    usage: &AccountUsage,
    now: i64,
    locale: &str,
    utc_offset_seconds: i32,
    strings: &UsageLineStrings,
) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(session) = &usage.session {
        let percent = percent_now(Some(session), now).unwrap_or(0);
        parts.push(fmt(
            &strings.usage_session,
            &json!({ "percent": percent.to_string() }),
        ));
    }
    if let Some(weekly) = &usage.weekly {
        let percent = percent_now(Some(weekly), now).unwrap_or(0);
        parts.push(fmt(
            &strings.usage_weekly,
            &json!({ "percent": percent.to_string() }),
        ));
        if weekly.resets_at > now {
            parts.push(fmt(
                &strings.usage_pace,
                &json!({ "percent": weekly_pace(weekly, now).to_string() }),
            ));
            parts.push(fmt(
                &strings.usage_resets,
                &json!({ "when": reset_when(weekly.resets_at, now, locale, utc_offset_seconds) }),
            ));
        }
    }
    parts
}

pub fn is_stale(usage: &AccountUsage, now: i64) -> bool {
    now - usage.checked_at > STALE_AFTER_MS
}
