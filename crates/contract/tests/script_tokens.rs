#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

use ostia_contract::script_tokens::token_expiry;

const NEW_YORK_BEFORE_THE_GAP_MS: i64 = 1_741_419_000_000;

#[test]
#[ignore = "runs in a child process with TZ set"]
fn a_year_that_lands_in_a_dst_gap_shifts_forward_as_javascript_does() {
    assert_eq!(
        token_expiry("1y", NEW_YORK_BEFORE_THE_GAP_MS),
        Ok(Some("2026-03-08T07:30:00.000Z".to_owned()))
    );
}

#[test]
fn the_dst_gap_case_passes_in_a_new_york_time_zone() {
    let exe = std::env::current_exe().unwrap();
    let run = Command::new(exe)
        .env("TZ", "America/New_York")
        .args([
            "--exact",
            "a_year_that_lands_in_a_dst_gap_shifts_forward_as_javascript_does",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .unwrap();
    let report = format!(
        "{}{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    assert!(run.status.success(), "{report}");
    assert!(report.contains("1 passed"), "{report}");
}
