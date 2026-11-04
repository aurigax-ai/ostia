use chrono::{DateTime, FixedOffset};
use ostia_base::js::js_round;
use ostia_contract::claude_accounts::{AccountUsage, UsageWindow, percent_now};
use ostia_contract::dict::fmt;
use serde_json::json;

use crate::locale_datetime::{Clock, HourDigits, clock_text, weekday_name};

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const INVALID_DATE: &str = "Invalid Date";
const STALE_AFTER_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageLineStrings {
    pub usage_session: String,
    pub usage_weekly: String,
    pub usage_pace: String,
    pub usage_resets: String,
}

pub fn weekly_pace(weekly: &UsageWindow, now: i64) -> i64 {
    if weekly.resets_at <= now {
        return 0;
    }
    let elapsed = WEEK_MS - (weekly.resets_at - now);
    let share = js_round(elapsed as f64 / WEEK_MS as f64 * 100.0);
    share.clamp(0.0, 100.0) as i64
}

fn reset_when(resets_at: i64, now: i64, locale: &str, utc_offset_seconds: i32) -> String {
    let (Some(offset), Some(instant)) = (
        FixedOffset::east_opt(utc_offset_seconds),
        DateTime::from_timestamp_millis(resets_at),
    ) else {
        return INVALID_DATE.to_owned();
    };
    let local = instant.with_timezone(&offset);
    let text = if resets_at - now < DAY_MS {
        clock_text(locale, local.time(), Clock::Locale, HourDigits::Numeric)
    } else {
        weekday_name(locale, local.date_naive())
    };
    text.unwrap_or_else(|| INVALID_DATE.to_owned())
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
