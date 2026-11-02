const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const MINUTE_MS: i64 = 60_000;
const ISO_LEN: usize = 24;

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub fn format_iso(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    let rest = ms.rem_euclid(DAY_MS);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / HOUR_MS,
        rest / MINUTE_MS % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

fn digits(text: &str, from: usize, to: usize) -> Option<i64> {
    let part = text.get(from..to)?;
    if !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == ISO_LEN
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z';
    if !shaped {
        return None;
    }
    let year = digits(text, 0, 4)?;
    let month = digits(text, 5, 7)?;
    let day = digits(text, 8, 10)?;
    let hour = digits(text, 11, 13)?;
    let minute = digits(text, 14, 16)?;
    let second = digits(text, 17, 19)?;
    let millis = digits(text, 20, 23)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(
        days_from_civil(year, month, day) * DAY_MS
            + hour * HOUR_MS
            + minute * MINUTE_MS
            + second * 1000
            + millis,
    )
}
