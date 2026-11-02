use fixed_decimal::Decimal;
use icu_experimental::relativetime::options::Numeric;
use icu_experimental::relativetime::{
    RelativeTimeFormatter, RelativeTimeFormatterOptions, RelativeTimeFormatterPreferences,
};
use icu_locale_core::Locale;
use writeable::Writeable;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelativeUnit {
    Year,
    Quarter,
    Month,
    Week,
    Day,
    Hour,
    Minute,
    Second,
}

pub type RelativeStep = (RelativeUnit, f64);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelativeTimeError {
    #[error("Incorrect locale information provided")]
    InvalidLocale,
    #[error("Value need to be finite number for Intl.RelativeTimeFormat.prototype.format()")]
    NotFinite,
    #[error("no relative time step was given")]
    NoSteps,
    #[error("no relative time data: {0}")]
    Data(String),
}

#[derive(Clone, Debug)]
pub struct RelativeTimeFormat {
    locale: Option<Locale>,
}

impl RelativeTimeFormat {
    pub fn new(locale: &str) -> Self {
        Self {
            locale: locale.parse().ok(),
        }
    }

    fn format(&self, value: i64, unit: RelativeUnit) -> Result<String, RelativeTimeError> {
        let locale = self
            .locale
            .clone()
            .ok_or(RelativeTimeError::InvalidLocale)?;
        let prefs = RelativeTimeFormatterPreferences::from(locale);
        let options = RelativeTimeFormatterOptions::default().with_numeric(Numeric::Auto);
        let formatter = match unit {
            RelativeUnit::Year => RelativeTimeFormatter::try_new_long_year(prefs, options),
            RelativeUnit::Quarter => RelativeTimeFormatter::try_new_long_quarter(prefs, options),
            RelativeUnit::Month => RelativeTimeFormatter::try_new_long_month(prefs, options),
            RelativeUnit::Week => RelativeTimeFormatter::try_new_long_week(prefs, options),
            RelativeUnit::Day => RelativeTimeFormatter::try_new_long_day(prefs, options),
            RelativeUnit::Hour => RelativeTimeFormatter::try_new_long_hour(prefs, options),
            RelativeUnit::Minute => RelativeTimeFormatter::try_new_long_minute(prefs, options),
            RelativeUnit::Second => RelativeTimeFormatter::try_new_long_second(prefs, options),
        }
        .map_err(|error| RelativeTimeError::Data(error.to_string()))?;
        Ok(formatter
            .format(Decimal::from(value))
            .write_to_string()
            .into_owned())
    }
}

fn round_half_up(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

pub fn format_relative(
    diff: f64,
    steps: &[RelativeStep],
    format: &RelativeTimeFormat,
) -> Result<String, RelativeTimeError> {
    let (unit, size) = steps
        .iter()
        .find(|step| diff.abs() >= step.1)
        .or_else(|| steps.last())
        .copied()
        .ok_or(RelativeTimeError::NoSteps)?;
    let count = round_half_up(diff / size);
    if !count.is_finite() {
        return Err(RelativeTimeError::NotFinite);
    }
    format.format(count as i64, unit)
}
