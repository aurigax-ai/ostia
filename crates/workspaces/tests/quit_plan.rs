#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use ostia_contract::windows_api::QuitAnswer;
use ostia_workspaces::quit_plan::{
    KeptOnQuit, QUIT_SIGNALS, QuitPane, QuitPlan, QuitState, create_quit_trace,
    exit_after_deadline, keeps_shells_on_quit, kept_on_quit, plan_quit, summarize_kinds,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

fn idle() -> QuitState {
    QuitState {
        approved: false,
        requested_by_ostia: false,
        signaled: false,
        platform: "linux".to_owned(),
    }
}

#[test]
fn proceeds_once_the_quit_was_approved() {
    let state = QuitState {
        approved: true,
        signaled: true,
        ..idle()
    };
    assert_eq!(plan_quit(&state), QuitPlan::Proceed);
}

#[test]
fn asks_about_running_commands_when_ostia_itself_started_the_quit() {
    let state = QuitState {
        requested_by_ostia: true,
        ..idle()
    };
    assert_eq!(plan_quit(&state), QuitPlan::Ask);
}

#[test]
fn quits_unattended_when_a_signal_sigterm_sigint_sighup_started_the_quit() {
    let state = QuitState {
        signaled: true,
        ..idle()
    };
    assert_eq!(plan_quit(&state), QuitPlan::Unattended);
    assert_eq!(QUIT_SIGNALS, ["SIGTERM", "SIGINT", "SIGHUP"]);
}

#[test]
fn quits_unattended_on_linux_when_neither_ostia_nor_a_known_signal_started_the_quit() {
    assert_eq!(plan_quit(&idle()), QuitPlan::Unattended);
}

#[test]
fn quits_unattended_on_macos_too_when_a_signal_started_the_quit() {
    for requested_by_ostia in [false, true] {
        let state = QuitState {
            platform: "darwin".to_owned(),
            requested_by_ostia,
            signaled: true,
            ..idle()
        };
        assert_eq!(
            plan_quit(&state),
            QuitPlan::Unattended,
            "{requested_by_ostia}"
        );
    }
}

#[test]
fn still_asks_on_macos_where_the_app_menu_quits_without_going_through_ostia() {
    let state = QuitState {
        platform: "darwin".to_owned(),
        ..idle()
    };
    assert_eq!(plan_quit(&state), QuitPlan::Ask);
}

#[tokio::test(start_paused = true)]
async fn exits_when_the_quit_has_not_finished_by_the_deadline() {
    let exits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&exits);
    let timer = exit_after_deadline(
        move || {
            counter.fetch_add(1, Ordering::SeqCst);
        },
        Duration::from_millis(1000),
    );
    tokio::time::advance(Duration::from_millis(999)).await;
    tokio::task::yield_now().await;
    assert_eq!(exits.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_millis(1)).await;
    timer.await.unwrap();
    assert_eq!(exits.load(Ordering::SeqCst), 1);
}

fn panes() -> Vec<QuitPane> {
    vec![
        QuitPane {
            pane_id: "p1".to_owned(),
            kept: true,
        },
        QuitPane {
            pane_id: "p2".to_owned(),
            kept: false,
        },
    ]
}

fn kept_and_offer(kept: &[&str], offer: &[&str]) -> KeptOnQuit {
    KeptOnQuit {
        kept: kept.iter().map(|s| (*s).to_owned()).collect(),
        offer: offer.iter().map(|s| (*s).to_owned()).collect(),
    }
}

#[test]
fn ksh_c39_leaves_the_kept_shells_out_of_the_question_when_ostia_restarts_since_they_live_on() {
    assert_eq!(
        kept_on_quit(true, true, &panes()),
        kept_and_offer(&["p1"], &[])
    );
}

#[test]
fn ksh_c40_offers_to_keep_the_kept_shells_when_ostia_quits_and_asks_before_quitting() {
    assert_eq!(
        kept_on_quit(false, true, &panes()),
        kept_and_offer(&["p1"], &["p1"])
    );
}

#[test]
fn ksh_c92_offers_nothing_when_no_shell_is_kept() {
    let none_kept = [QuitPane {
        pane_id: "p2".to_owned(),
        kept: false,
    }];
    assert_eq!(
        kept_on_quit(false, true, &none_kept),
        kept_and_offer(&[], &[])
    );
}

#[test]
fn ksh_c93_offers_nothing_and_asks_about_every_command_when_quitting_does_not_ask() {
    assert_eq!(
        kept_on_quit(false, false, &panes()),
        kept_and_offer(&[], &[])
    );
}

#[test]
fn ksh_c94_keeps_the_shells_when_the_quit_chose_to_keep_them() {
    assert!(keeps_shells_on_quit(false, Some(QuitAnswer::KeepShells)));
}

#[test]
fn ksh_c95_ends_the_shells_when_the_quit_chose_to_end_them_or_nobody_was_asked() {
    assert!(!keeps_shells_on_quit(false, Some(QuitAnswer::Quit)));
    assert!(!keeps_shells_on_quit(false, None));
}

#[test]
fn ksh_c96_keeps_the_shells_on_a_restart_whatever_the_answer() {
    assert!(keeps_shells_on_quit(true, None));
    assert!(keeps_shells_on_quit(true, Some(QuitAnswer::Quit)));
}

#[test]
fn logs_each_stage_with_the_stage_before_it_how_long_that_one_took_and_the_time_since_the_quit_began()
 {
    let entries: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let clock = Arc::new(AtomicI64::new(1000));
    let sink = Arc::clone(&entries);
    let reading = Arc::clone(&clock);
    let mut trace = create_quit_trace(
        move |event, fields| sink.lock().push((event.to_owned(), fields)),
        move || reading.load(Ordering::SeqCst),
    );
    assert_eq!(trace.current(), "idle");
    assert_eq!(trace.elapsed_ms(), 0);
    trace.stage("scrollback");
    clock.fetch_add(40, Ordering::SeqCst);
    trace.stage("telemetry");
    clock.fetch_add(5, Ordering::SeqCst);
    trace.stage("teardown");
    clock.fetch_add(7, Ordering::SeqCst);
    assert_eq!(
        *entries.lock(),
        [
            (
                "quit-stage".to_owned(),
                json!({"stage": "scrollback", "after": "idle", "tookMs": 0, "totalMs": 0})
            ),
            (
                "quit-stage".to_owned(),
                json!({"stage": "telemetry", "after": "scrollback", "tookMs": 40, "totalMs": 40})
            ),
            (
                "quit-stage".to_owned(),
                json!({"stage": "teardown", "after": "telemetry", "tookMs": 5, "totalMs": 45})
            ),
        ]
    );
    assert_eq!(trace.current(), "teardown");
    assert_eq!(trace.elapsed_ms(), 52);
}

#[test]
fn counts_the_resources_that_keep_the_process_alive_by_kind_in_a_stable_order() {
    assert_eq!(
        summarize_kinds(&["TCPSocketWrap", "ProcessWrap", "TCPSocketWrap", "Timeout"]),
        "ProcessWrap:1,TCPSocketWrap:2,Timeout:1"
    );
    assert_eq!(summarize_kinds(&[]), "");
}
