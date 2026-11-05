use chrono::{Local, TimeZone};
use ostia_contract::view_bindings::{
    ViewDates, ViewFormat, ViewScope, resolve_args_with, resolve_text_with, resolve_value_with,
};
use serde_json::Value;

use crate::locale_datetime::{Clock, HourDigits, clock_text, medium_date_without_weekday};

pub use ostia_contract::view_bindings::truthy;

struct LocalDates;

fn local_clock(ms: f64) -> Option<chrono::DateTime<Local>> {
    Local.timestamp_millis_opt(ms as i64).single()
}

impl ViewDates for LocalDates {
    fn time(&self, ms: f64, locale: &str) -> String {
        local_clock(ms)
            .and_then(|at| clock_text(locale, at.time(), Clock::Locale, HourDigits::TwoDigit))
            .unwrap_or_default()
    }

    fn date(&self, ms: f64, locale: &str) -> String {
        local_clock(ms)
            .and_then(|at| medium_date_without_weekday(locale, at.date_naive()))
            .unwrap_or_default()
    }
}

pub fn resolve_value(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    resolve_value_with(template, scope, fmt, &LocalDates)
}

pub fn resolve_text(template: &str, scope: &ViewScope, fmt: &ViewFormat) -> String {
    resolve_text_with(template, scope, fmt, &LocalDates)
}

pub fn resolve_args(value: &Value, scope: &ViewScope, fmt: &ViewFormat) -> Value {
    resolve_args_with(value, scope, fmt, &LocalDates)
}
