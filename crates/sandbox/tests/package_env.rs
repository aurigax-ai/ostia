#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_sandbox::package_env::package_cooldown_env;

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn sets_each_package_manager_cooldown_from_the_policy_and_nothing_when_it_is_off() {
    let now = 1_790_769_600_000;
    assert_eq!(
        package_cooldown_env(2, now),
        pairs(&[
            ("NPM_CONFIG_MIN_RELEASE_AGE", "2"),
            ("PNPM_CONFIG_MINIMUM_RELEASE_AGE", "2880"),
            ("UV_EXCLUDE_NEWER", "2026-09-28T12:00:00.000Z"),
            ("PIP_UPLOADED_PRIOR_TO", "2026-09-28T12:00:00.000Z"),
        ])
    );
    assert_eq!(package_cooldown_env(0, now), Vec::new());
}

#[test]
fn sets_nothing_for_a_negative_cooldown() {
    assert_eq!(package_cooldown_env(-3, 1_790_769_600_000), Vec::new());
}

#[test]
fn writes_the_cutoff_time_with_milliseconds() {
    let env = package_cooldown_env(1, 1_790_769_600_123);
    let cutoff = env
        .iter()
        .find(|(name, _)| name == "UV_EXCLUDE_NEWER")
        .map(|(_, value)| value.as_str());
    assert_eq!(cutoff, Some("2026-09-29T12:00:00.123Z"));
}
