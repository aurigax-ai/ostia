#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike, Utc};
use ostia_contract::capabilities::Capability;
use ostia_contract::script_tokens::{
    DEFAULT_TOKEN_EXPIRY, NEVER_EXPIRES, POLKIT_ACTION, POLKIT_ACTIONS_DIR, POLKIT_POLICY_FILE,
    SCRIPT_CAPABILITIES, SCRIPT_TOKEN_PREFIX, SCRIPT_TOKEN_PRESETS, SCRIPT_TOKEN_RUN_CAPS,
    SCRIPT_TOKEN_UI_CAPS, ScriptTokenCall, ScriptTokenCallOutcome, ScriptTokenCallTarget,
    ScriptTokenInfo, ScriptTokenPreset, ScriptTokenScope, ScriptTokenSource,
    is_script_token_preset, token_expiry,
};
use serde_json::{Value, json};

const NOW: i64 = 1_793_591_677_254;
const DAY_MS: i64 = 86_400_000;

fn local_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> i64 {
    Local
        .with_ymd_and_hms(year, month, day, hour, minute, second)
        .earliest()
        .unwrap()
        .timestamp_millis()
}

fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn unreadable(raw: &str) -> String {
    format!("expires: {raw} (use 7d, 30d, 90d, 1y, YYYY-MM-DD or never)")
}

fn expiry(raw: &str, now: i64) -> String {
    token_expiry(raw, now).unwrap().unwrap()
}

#[test]
fn keeps_the_token_prefix_and_the_polkit_names() {
    assert_eq!(SCRIPT_TOKEN_PREFIX, "ostia_");
    assert_eq!(POLKIT_ACTION, "ai.aurigax.ostia.manage-script-tokens");
    assert_eq!(
        POLKIT_POLICY_FILE,
        "ai.aurigax.ostia.manage-script-tokens.policy"
    );
    assert_eq!(POLKIT_ACTIONS_DIR, "/usr/share/polkit-1/actions");
}

#[test]
fn lists_the_script_capabilities_in_order() {
    let names: Vec<&str> = SCRIPT_CAPABILITIES.iter().map(|cap| cap.name()).collect();
    assert_eq!(
        names,
        [
            "read-board",
            "read-other-pane",
            "type-other-pane",
            "all-workspaces",
            "process",
            "send-other-pane",
            "kill-pane",
            "notify",
        ]
    );
}

#[test]
fn lists_the_capabilities_that_the_token_screen_offers() {
    let names: Vec<&str> = SCRIPT_TOKEN_UI_CAPS.iter().map(|cap| cap.name()).collect();
    assert_eq!(
        names,
        [
            "read-board",
            "notify",
            "read-other-pane",
            "send-other-pane",
            "kill-pane",
            "type-other-pane",
            "process",
        ]
    );
    for cap in SCRIPT_TOKEN_UI_CAPS {
        assert!(SCRIPT_CAPABILITIES.contains(&cap), "{cap:?}");
    }
}

#[test]
fn marks_the_run_capabilities() {
    assert_eq!(
        SCRIPT_TOKEN_RUN_CAPS,
        [Capability::TypeOtherPane, Capability::Process]
    );
}

#[test]
fn defines_the_readonly_and_coordinator_presets() {
    assert_eq!(
        ScriptTokenPreset::Readonly.caps(),
        [Capability::ReadBoard, Capability::ReadOtherPane]
    );
    assert_eq!(
        ScriptTokenPreset::Coordinator.caps(),
        [
            Capability::ReadBoard,
            Capability::ReadOtherPane,
            Capability::SendOtherPane,
            Capability::TypeOtherPane,
            Capability::Process,
            Capability::Notify,
        ]
    );
    assert_eq!(
        SCRIPT_TOKEN_PRESETS,
        [ScriptTokenPreset::Readonly, ScriptTokenPreset::Coordinator]
    );
}

#[test]
fn accepts_only_a_string_that_names_a_preset() {
    assert!(is_script_token_preset(&json!("readonly")));
    assert!(is_script_token_preset(&json!("coordinator")));
    let refused: [Value; 9] = [
        json!(""),
        json!("Readonly"),
        json!("toString"),
        json!("constructor"),
        json!("__proto__"),
        json!(null),
        json!(1),
        json!(["readonly"]),
        json!({"readonly": true}),
    ];
    for raw in refused {
        assert!(!is_script_token_preset(&raw), "{raw}");
    }
}

#[test]
fn keeps_the_default_expiry_and_the_never_word() {
    assert_eq!(DEFAULT_TOKEN_EXPIRY, "90d");
    assert_eq!(NEVER_EXPIRES, "never");
}

#[test]
fn never_expires_gives_no_date() {
    assert_eq!(token_expiry("never", NOW), Ok(None));
}

#[test]
fn adds_whole_days_to_now() {
    for (raw, days) in [
        ("1d", 1),
        ("7d", 7),
        ("30d", 30),
        ("90d", 90),
        ("9999d", 9999),
    ] {
        assert_eq!(expiry(raw, NOW), iso(NOW + days * DAY_MS), "{raw}");
    }
}

#[test]
fn adds_whole_years_in_local_time() {
    let now = local_ms(2026, 6, 15, 10, 30, 0);
    assert_eq!(expiry("1y", now), iso(local_ms(2027, 6, 15, 10, 30, 0)));
    assert_eq!(expiry("3y", now), iso(local_ms(2029, 6, 15, 10, 30, 0)));
}

#[test]
fn moves_a_leap_day_to_the_first_of_march_when_the_year_has_no_such_day() {
    let now = local_ms(2028, 2, 29, 12, 0, 0);
    assert_eq!(expiry("1y", now), iso(local_ms(2029, 3, 1, 12, 0, 0)));
    assert_eq!(expiry("4y", now), iso(local_ms(2032, 2, 29, 12, 0, 0)));
}

#[test]
fn writes_a_year_above_9999_as_a_signed_six_digit_year() {
    let result = expiry("9999y", NOW);
    assert!(result.starts_with("+012025-11-"), "{result}");
    assert!(result.ends_with('Z'), "{result}");
}

#[test]
fn ends_a_calendar_date_at_the_last_millisecond_of_its_local_day() {
    let result = expiry("2099-12-31", NOW);
    let at = DateTime::parse_from_rfc3339(&result)
        .unwrap()
        .with_timezone(&Local);
    assert_eq!((at.year(), at.month(), at.day()), (2099, 12, 31));
    assert_eq!((at.hour(), at.minute(), at.second()), (23, 59, 59));
    assert_eq!(at.timestamp_subsec_millis(), 999);
}

#[test]
fn accepts_today_and_refuses_the_moment_the_day_has_ended() {
    let end = local_ms(2030, 6, 15, 23, 59, 59) + 999;
    assert_eq!(expiry("2030-06-15", end - 1), iso(end));
    assert_eq!(
        token_expiry("2030-06-15", end),
        Err("expires: 2030-06-15 is in the past".to_owned())
    );
    assert_eq!(
        token_expiry("2030-06-15", end + 1),
        Err("expires: 2030-06-15 is in the past".to_owned())
    );
}

#[test]
fn refuses_a_date_in_the_past() {
    assert_eq!(
        token_expiry("2020-01-01", NOW),
        Err("expires: 2020-01-01 is in the past".to_owned())
    );
}

#[test]
fn refuses_a_date_that_does_not_exist() {
    for raw in [
        "2026-02-30",
        "2027-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-04-31",
        "2026-01-00",
        "2026-01-32",
    ] {
        assert_eq!(token_expiry(raw, NOW), Err(unreadable(raw)), "{raw}");
    }
    assert!(token_expiry("2028-02-29", NOW).is_ok());
}

#[test]
fn refuses_a_year_below_one_hundred() {
    assert_eq!(
        token_expiry("0050-01-01", NOW),
        Err(unreadable("0050-01-01"))
    );
}

#[test]
fn refuses_text_that_is_not_a_known_expiry() {
    for raw in [
        "",
        "0d",
        "0y",
        "10000d",
        "10000y",
        "07d",
        "7",
        "d",
        "y",
        "7w",
        "7D",
        "1Y",
        " 7d",
        "7d ",
        "7 d",
        "-7d",
        "1.5d",
        "Never",
        "never ",
        "forever",
        "2026-1-1",
        "26-01-01",
        "2026/01/01",
        "2026-01-01T00:00:00Z",
        " 2099-01-01",
        "2099-01-01 ",
    ] {
        assert_eq!(token_expiry(raw, NOW), Err(unreadable(raw)), "{raw:?}");
    }
}

#[test]
fn refuses_digits_that_are_not_ascii() {
    for raw in ["٧d", "２０９９-01-01"] {
        assert_eq!(token_expiry(raw, NOW), Err(unreadable(raw)), "{raw}");
    }
}

#[test]
fn writes_an_all_scope_and_a_limited_scope() {
    assert_eq!(
        serde_json::to_value(ScriptTokenScope::All).unwrap(),
        json!({"kind": "all"})
    );
    let limited = ScriptTokenScope::Limited {
        groups: vec!["g1".to_owned()],
        workspaces: vec!["w1".to_owned(), "w2".to_owned()],
        own_workspaces: true,
    };
    assert_eq!(
        serde_json::to_string(&limited).unwrap(),
        r#"{"kind":"limited","groups":["g1"],"workspaces":["w1","w2"],"ownWorkspaces":true}"#
    );
}

#[test]
fn writes_a_token_in_field_order_with_null_dates() {
    let info = ScriptTokenInfo {
        id: "t1".to_owned(),
        name: "ci".to_owned(),
        caps: vec![Capability::ReadBoard],
        scope: ScriptTokenScope::All,
        created_at: "2026-11-02T00:00:00.000Z".to_owned(),
        updated_at: "2026-11-02T00:00:00.000Z".to_owned(),
        expires_at: None,
        last_used_at: None,
        source: ScriptTokenSource::Cli,
    };
    assert_eq!(
        serde_json::to_string(&info).unwrap(),
        r#"{"id":"t1","name":"ci","caps":["read-board"],"scope":{"kind":"all"},"createdAt":"2026-11-02T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z","expiresAt":null,"lastUsedAt":null,"source":"cli"}"#
    );
    assert_eq!(
        serde_json::to_value(ScriptTokenSource::Settings).unwrap(),
        json!("settings")
    );
}

#[test]
fn writes_a_call_without_a_code_and_without_missing_target_ids() {
    let call = ScriptTokenCall {
        at: "2026-11-02T00:00:00.000Z".to_owned(),
        method: "pane.list".to_owned(),
        target: ScriptTokenCallTarget {
            workspace_id: Some("w1".to_owned()),
            pane_id: None,
        },
        outcome: ScriptTokenCallOutcome::Ok,
        code: None,
    };
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"at":"2026-11-02T00:00:00.000Z","method":"pane.list","target":{"workspaceId":"w1"},"outcome":"ok"}"#
    );
    let refused = ScriptTokenCall {
        outcome: ScriptTokenCallOutcome::OutOfScope,
        code: Some("scope".to_owned()),
        ..call
    };
    assert!(
        serde_json::to_string(&refused)
            .unwrap()
            .ends_with(r#""outcome":"out-of-scope","code":"scope"}"#)
    );
    for (outcome, name) in [
        (
            ScriptTokenCallOutcome::MissingPermission,
            "missing-permission",
        ),
        (ScriptTokenCallOutcome::Error, "error"),
        (ScriptTokenCallOutcome::Regenerated, "regenerated"),
    ] {
        assert_eq!(serde_json::to_value(outcome).unwrap(), json!(name));
    }
}

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
