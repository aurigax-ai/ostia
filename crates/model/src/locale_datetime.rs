use chrono::{Datelike, NaiveDate, NaiveTime, Timelike};
use icu_calendar::{Date, Gregorian, Iso};
use icu_datetime::fieldsets::{E, T, YMD, YMDE};
use icu_datetime::input::{DateTime, Time};
use icu_datetime::pattern::{DateTimePattern, FixedCalendarDateTimeNames};
use icu_datetime::preferences::HourCycle;
use icu_datetime::{
    DateTimeFormatter, DateTimeFormatterPreferences, FixedCalendarDateTimeFormatter,
    NoCalendarFormatter,
};
use icu_locale_core::Locale;
use writeable::TryWriteable;

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

fn abbreviate_pattern(pattern: &str) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            quoted = !quoted;
            out.push(c);
            continue;
        }
        if quoted || !c.is_ascii_alphabetic() {
            out.push(c);
            continue;
        }
        let mut run = 1;
        while chars.next_if_eq(&c).is_some() {
            run += 1;
        }
        match c {
            'E' | 'e' | 'c' => out.push_str("EEE"),
            'M' | 'L' => out.push_str("MMM"),
            'd' => out.push_str("dd"),
            _ => out.extend(std::iter::repeat_n(c, run)),
        }
    }
    out
}

pub fn medium_date(locale: &str, date: NaiveDate) -> Option<String> {
    let prefs = preferences(locale, Clock::Locale);
    let day = Date::try_new_gregorian(
        date.year(),
        u8::try_from(date.month()).ok()?,
        u8::try_from(date.day()).ok()?,
    )
    .ok()?;
    let long = FixedCalendarDateTimeFormatter::<Gregorian, _>::try_new(prefs, YMDE::long()).ok()?;
    let pattern: DateTimePattern = abbreviate_pattern(&long.format(&day).pattern().to_string())
        .parse()
        .ok()?;
    let mut names = FixedCalendarDateTimeNames::<Gregorian>::try_new(prefs).ok()?;
    let formatter = names.include_for_pattern(&pattern).ok()?;
    let input = DateTime {
        date: day,
        time: Time::try_new(0, 0, 0, 0).ok()?,
    };
    Some(
        formatter
            .format(&input)
            .try_write_to_string()
            .ok()?
            .into_owned(),
    )
}

pub fn medium_date_without_weekday(locale: &str, date: NaiveDate) -> Option<String> {
    let day = Date::try_new_gregorian(
        date.year(),
        u8::try_from(date.month()).ok()?,
        u8::try_from(date.day()).ok()?,
    )
    .ok()?;
    let formatter = FixedCalendarDateTimeFormatter::<Gregorian, _>::try_new(
        preferences(locale, Clock::Locale),
        YMD::medium(),
    )
    .ok()?;
    Some(formatter.format(&day).to_string())
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
