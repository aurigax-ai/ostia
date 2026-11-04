use chrono::DateTime;

pub fn iso_millis(millis: i64) -> String {
    DateTime::from_timestamp_millis(millis)
        .map(|moment| moment.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}
