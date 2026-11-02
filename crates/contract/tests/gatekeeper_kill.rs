#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::gatekeeper_kill::{
    DEVELOPER_TOOLS_SETTING_URL, ExitFacts, GATEKEEPER_WINDOW_MS, SIGKILL_EXIT_CODE,
    gatekeeper_hint, maybe_ended_by_gatekeeper,
};

fn base() -> ExitFacts<'static> {
    ExitFacts {
        platform: "darwin",
        exit_code: Some(SIGKILL_EXIT_CODE),
        ran_ms: Some(1200.0),
    }
}

#[test]
fn flags_a_sigkill_exit_on_macos_shortly_after_the_command_started() {
    assert!(maybe_ended_by_gatekeeper(&base()));
    assert!(maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: Some(0.0),
        ..base()
    }));
}

#[test]
fn stops_flagging_at_the_window_boundary() {
    let window = GATEKEEPER_WINDOW_MS as f64;
    assert!(maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: Some(window - 1.0),
        ..base()
    }));
    assert!(!maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: Some(window),
        ..base()
    }));
    assert!(!maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: Some(window + 1.0),
        ..base()
    }));
}

#[test]
fn ignores_other_platforms() {
    for platform in ["linux", "win32"] {
        assert!(
            !maybe_ended_by_gatekeeper(&ExitFacts { platform, ..base() }),
            "{platform}"
        );
    }
}

#[test]
fn ignores_other_exit_codes_and_unknown_ones() {
    for exit_code in [
        Some(0),
        Some(1),
        Some(130),
        Some(136),
        Some(138),
        Some(143),
        None,
    ] {
        assert!(
            !maybe_ended_by_gatekeeper(&ExitFacts {
                exit_code,
                ..base()
            }),
            "{exit_code:?}"
        );
    }
}

#[test]
fn ignores_a_run_whose_duration_is_unknown_or_negative() {
    assert!(!maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: None,
        ..base()
    }));
    assert!(!maybe_ended_by_gatekeeper(&ExitFacts {
        ran_ms: Some(-1.0),
        ..base()
    }));
}

#[test]
fn names_the_cause_as_possible_gives_the_steps_and_links_the_setting() {
    let hint = gatekeeper_hint("Ostia");
    assert!(hint.contains("Gatekeeper may have ended"));
    assert!(hint.contains("Privacy & Security > Developer Tools"));
    assert!(hint.contains("add or turn on Ostia"));
    assert!(hint.contains(DEVELOPER_TOOLS_SETTING_URL));
    assert!(hint.contains(&format!("{} seconds", GATEKEEPER_WINDOW_MS / 1000)));
}

#[test]
fn does_not_tell_the_user_to_strip_the_quarantine_attribute_or_claim_a_state() {
    let hint = gatekeeper_hint("Ostia").to_lowercase();
    assert!(!hint.contains("xattr"));
    assert!(!hint.contains("quarantine"));
    assert!(!hint.contains("is enabled"));
    assert!(!hint.contains("is not enabled"));
    assert!(!hint.contains("is disabled"));
}

#[test]
fn keeps_the_constants_and_the_exact_hint_text_of_the_ts_module() {
    assert_eq!(GATEKEEPER_WINDOW_MS, 5000);
    assert_eq!(SIGKILL_EXIT_CODE, 137);
    assert_eq!(
        DEVELOPER_TOOLS_SETTING_URL,
        "x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools"
    );
    assert_eq!(
        gatekeeper_hint("Ostia"),
        "macOS Gatekeeper may have ended this process: it was killed (exit 137) within 5 seconds of starting. If the program was just installed or upgraded, open System Settings > Privacy & Security > Developer Tools, add or turn on Ostia (use the + button if it is not listed), then run it again. Setting: x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools"
    );
}
