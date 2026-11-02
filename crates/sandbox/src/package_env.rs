use chrono::{DateTime, Utc};

const DAY_MS: i64 = 24 * 3_600_000;
const MINUTES_PER_DAY: i64 = 24 * 60;

pub fn package_cooldown_env(cooldown_days: i64, now: i64) -> Vec<(String, String)> {
    if cooldown_days <= 0 {
        return Vec::new();
    }
    let cutoff = now.saturating_sub(cooldown_days.saturating_mul(DAY_MS));
    let before = DateTime::<Utc>::from_timestamp_millis(cutoff)
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    vec![
        (
            "NPM_CONFIG_MIN_RELEASE_AGE".to_owned(),
            cooldown_days.to_string(),
        ),
        (
            "PNPM_CONFIG_MINIMUM_RELEASE_AGE".to_owned(),
            cooldown_days.saturating_mul(MINUTES_PER_DAY).to_string(),
        ),
        ("UV_EXCLUDE_NEWER".to_owned(), before.clone()),
        ("PIP_UPLOADED_PRIOR_TO".to_owned(), before),
    ]
}
