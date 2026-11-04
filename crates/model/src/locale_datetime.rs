use chrono::{Datelike, NaiveDate, NaiveTime, Timelike};
use icu_calendar::{Date, Iso};
use icu_datetime::fieldsets::{E, T, YMDE};
use icu_datetime::input::Time;
use icu_datetime::options::Alignment;
use icu_datetime::preferences::HourCycle;
use icu_datetime::{DateTimeFormatter, DateTimeFormatterPreferences, NoCalendarFormatter};
use icu_locale_core::Locale;

const NARROW_NO_BREAK_SPACE: char = '\u{202f}';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clock {
    Locale,
    Twelve,
    TwentyFour,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HourDigits {
    Numeric,
    TwoDigit,
}

fn preferences(locale: &str, clock: Clock) -> DateTimeFormatterPreferences {
    let locale = Locale::try_from_str(locale).unwrap_or(Locale::UNKNOWN);
    let mut prefs = DateTimeFormatterPreferences::from(locale);
    prefs.hour_cycle = match clock {
        Clock::Locale => prefs.hour_cycle,
        Clock::Twelve => Some(HourCycle::Clock12),
        Clock::TwentyFour => Some(HourCycle::Clock24),
    };
    prefs
}

fn icu_date(date: NaiveDate) -> Option<Date<Iso>> {
    Date::try_new_iso(
        date.year(),
        u8::try_from(date.month()).ok()?,
        u8::try_from(date.day()).ok()?,
    )
    .ok()
}

fn pad_leading_hour(text: &str) -> String {
    let Some(start) = text.find(|c: char| c.is_ascii_digit()) else {
        return text.to_owned();
    };
    let run = text[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    if run == 1 {
        format!("{}0{}", &text[..start], &text[start..])
    } else {
        text.to_owned()
    }
}

pub fn medium_date(locale: &str, date: NaiveDate) -> Option<String> {
    let formatter = DateTimeFormatter::try_new(
        preferences(locale, Clock::Locale),
        YMDE::medium().with_alignment(Alignment::Column),
    )
    .ok()?;
    Some(formatter.format(&icu_date(date)?).to_string())
}

pub fn weekday_name(locale: &str, date: NaiveDate) -> Option<String> {
    let formatter =
        DateTimeFormatter::try_new(preferences(locale, Clock::Locale), E::medium()).ok()?;
    Some(formatter.format(&icu_date(date)?).to_string())
}

pub fn clock_text(
    locale: &str,
    time: NaiveTime,
    clock: Clock,
    digits: HourDigits,
) -> Option<String> {
    let formatter = NoCalendarFormatter::try_new(preferences(locale, clock), T::hm()).ok()?;
    let icu_time = Time::try_new(
        u8::try_from(time.hour()).ok()?,
        u8::try_from(time.minute()).ok()?,
        0,
        0,
    )
    .ok()?;
    let text = formatter
        .format(&icu_time)
        .to_string()
        .replace(NARROW_NO_BREAK_SPACE, " ");
    Some(match digits {
        HourDigits::Numeric => text,
        HourDigits::TwoDigit => pad_leading_hour(&text),
    })
}
