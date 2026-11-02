#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::pane_status::{
    PaneGit, PaneMail, PaneProcess, PaneState, PaneStatus, PaneStatusChanges, SHORT_ID_LENGTH,
    age_label, short_id, status_line,
};

fn base() -> PaneStatus {
    PaneStatus {
        pane: "p1".into(),
        title: "w-3".into(),
        state: PaneState::Done,
        since_ms: Some(2.0 * 60_000.0 + 5000.0),
        closing: Some("PR #1081 open, unit green".into()),
        keep_awake: false,
        exit_code: Some(0),
        process: None,
        git: Some(PaneGit {
            branch: Some("feat/inbox".into()),
            ahead: 1,
            behind: 0,
            changed: 2,
        }),
        mail: PaneMail {
            queued: 0,
            failed: 0,
            sent_queued: 0,
            sent_failed: 0,
        },
        stale: vec![],
        conflict: vec![],
        changes: PaneStatusChanges {
            first: false,
            states: vec!["working".into(), "done".into()],
            commands: 3,
            failed: 0,
            closing: true,
            mail: 0,
        },
    }
}

fn quiet_changes() -> PaneStatusChanges {
    PaneStatusChanges {
        first: false,
        states: vec![],
        commands: 0,
        failed: 0,
        closing: false,
        mail: 0,
    }
}

#[test]
fn counts_seconds_minutes_hours_and_days() {
    let labels: Vec<String> = [
        0.0,
        59_000.0,
        60_000.0,
        3_599_000.0,
        3_600_000.0,
        86_400_000.0 * 3.0,
    ]
    .into_iter()
    .map(age_label)
    .collect();
    assert_eq!(labels, ["0s", "59s", "1m", "59m", "1h", "3d"]);
}

#[test]
fn never_goes_below_zero() {
    assert_eq!(age_label(-5000.0), "0s");
}

#[test]
fn puts_state_age_exit_code_git_mail_the_closing_line_and_what_changed_on_one_line() {
    assert_eq!(
        status_line(&base()),
        "p1  w-3  done 2m  exit 0  feat/inbox +2 ↑1  mail 0  \"PR #1081 open, unit green\"  (since last: working→done, 3 commands, 0 failed, new closing line)"
    );
}

#[test]
fn marks_a_kept_awake_pane_after_its_state() {
    let line = status_line(&PaneStatus {
        keep_awake: true,
        ..base()
    });
    assert!(line.contains("exit 0  keep-awake  feat/inbox"), "{line}");
}

#[test]
fn says_first_look_the_first_time_and_no_change_when_nothing_happened() {
    let first = status_line(&PaneStatus {
        changes: PaneStatusChanges {
            first: true,
            ..base().changes
        },
        ..base()
    });
    assert!(first.contains("(first look)"), "{first}");
    let quiet = status_line(&PaneStatus {
        changes: quiet_changes(),
        ..base()
    });
    assert!(quiet.contains("(no change since last)"), "{quiet}");
}

#[test]
fn leaves_out_what_it_does_not_know_and_shows_failed_mail_and_a_process() {
    let line = status_line(&PaneStatus {
        since_ms: None,
        closing: None,
        exit_code: None,
        git: None,
        process: Some(PaneProcess {
            id: "web".into(),
            status: "running".into(),
        }),
        mail: PaneMail {
            queued: 2,
            failed: 1,
            sent_queued: 0,
            sent_failed: 0,
        },
        ..base()
    });
    assert!(
        line.contains("w-3  done  process web running  mail 2 failed 1  ("),
        "{line}"
    );
    assert!(!line.contains("exit"), "{line}");
}

#[test]
fn lists_what_has_been_stuck_and_nothing_when_nothing_is() {
    assert!(!status_line(&base()).contains("stale"));
    let line = status_line(&PaneStatus {
        stale: vec!["mail queued 38m".into(), "waking 3m".into()],
        ..base()
    });
    assert!(
        line.contains(
            "\"PR #1081 open, unit green\"  stale: mail queued 38m, waking 3m  (since last"
        ),
        "{line}"
    );
}

#[test]
fn names_the_panes_that_share_its_worktree_and_leaves_it_out_when_none_do() {
    assert!(!status_line(&base()).contains("conflict"));
    let line = status_line(&PaneStatus {
        conflict: vec!["w-4".into(), "w-5".into()],
        ..base()
    });
    assert!(line.contains("conflict: w-4, w-5"), "{line}");
}

#[test]
fn names_a_detached_head_and_shows_behind_commits() {
    let line = status_line(&PaneStatus {
        git: Some(PaneGit {
            branch: None,
            ahead: 0,
            behind: 3,
            changed: 0,
        }),
        ..base()
    });
    assert!(line.contains("detached ↓3"), "{line}");
}

#[test]
fn cuts_a_pane_id_to_the_short_length() {
    assert_eq!(SHORT_ID_LENGTH, 8);
    assert_eq!(short_id("0123456789abcdef"), "01234567");
    assert_eq!(short_id("p1"), "p1");
    assert_eq!(short_id(""), "");
    assert_eq!(
        status_line(&PaneStatus {
            pane: "0123456789abcdef".into(),
            ..base()
        })
        .split("  ")
        .next()
        .unwrap(),
        "01234567"
    );
}

#[test]
fn writes_the_closing_line_as_a_json_string() {
    let line = status_line(&PaneStatus {
        closing: Some("said \"ok\"\nthen left".into()),
        ..base()
    });
    assert!(line.contains("\"said \\\"ok\\\"\\nthen left\""), "{line}");
}

#[test]
fn leaves_out_an_empty_closing_line_and_a_zero_changed_count() {
    let line = status_line(&PaneStatus {
        closing: Some(String::new()),
        git: Some(PaneGit {
            branch: Some("main".into()),
            ahead: 0,
            behind: 0,
            changed: 0,
        }),
        ..base()
    });
    assert!(line.contains("exit 0  main  mail 0  ("), "{line}");
}

#[test]
fn shows_one_state_without_an_arrow_and_skips_commands_when_there_are_none() {
    let line = status_line(&PaneStatus {
        changes: PaneStatusChanges {
            states: vec!["done".into()],
            mail: 2,
            ..quiet_changes()
        },
        ..base()
    });
    assert!(line.ends_with("(since last: 2 mail delivered)"), "{line}");
}

#[test]
fn names_every_pane_state() {
    let names: Vec<&str> = [
        PaneState::Working,
        PaneState::Waiting,
        PaneState::Done,
        PaneState::Error,
        PaneState::Idle,
        PaneState::Hibernated,
        PaneState::Waking,
        PaneState::Exited,
        PaneState::Shell,
    ]
    .into_iter()
    .map(PaneState::as_str)
    .collect();
    assert_eq!(
        names,
        [
            "working",
            "waiting",
            "done",
            "error",
            "idle",
            "hibernated",
            "waking",
            "exited",
            "shell"
        ]
    );
}
