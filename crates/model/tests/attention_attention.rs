#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ostia_contract::attention::{KeptAttentionState, WorkspaceLiveState};
use ostia_contract::claude_attention::{ClaudeAttentionEvent, claude_attention};
use ostia_model::attention::{
    AttentionEvent, AttentionState, EMPTY_ATTENTION, KittyChunk, KittyNotificationAssembler,
    KittyPart, OscNotification, PaneAttention, TabMark, aggregate_workspace_state, latest_unread,
    latest_waiting_at, needs_you, notification_message, pane_live_state, parse_osc9, parse_osc99,
    parse_osc777, reduce_attention, tab_mark, unread_count,
};
use serde_json::json;

const AT: f64 = 100.0;

fn pane(state: AttentionState, unread: bool) -> PaneAttention {
    PaneAttention {
        state,
        unread,
        ..EMPTY_ATTENTION
    }
}

fn pane_with(state: AttentionState, unread: bool, message: Option<&str>, at: f64) -> PaneAttention {
    PaneAttention {
        state,
        unread,
        message: message.map(str::to_owned),
        at,
    }
}

fn reduce(prev: &PaneAttention, event: AttentionEvent) -> PaneAttention {
    reduce_attention(prev, &event)
}

fn set(state: AttentionState, message: Option<&str>) -> AttentionEvent {
    AttentionEvent::Set {
        state,
        message: message.map(str::to_owned),
        soft: false,
        at: AT,
    }
}

fn soft_set(state: AttentionState, message: &str) -> AttentionEvent {
    AttentionEvent::Set {
        state,
        message: Some(message.to_owned()),
        soft: true,
        at: AT,
    }
}

fn notify(message: &str, waiting: bool) -> AttentionEvent {
    AttentionEvent::Notify {
        message: message.to_owned(),
        waiting,
        at: AT,
    }
}

fn command_end(exit_code: i32, long: bool) -> AttentionEvent {
    AttentionEvent::CommandEnd {
        exit_code,
        long,
        message: None,
        at: AT,
    }
}

fn from_kept(state: KeptAttentionState) -> AttentionState {
    match state {
        KeptAttentionState::Working => AttentionState::Working,
        KeptAttentionState::Waiting => AttentionState::Waiting,
        KeptAttentionState::Done => AttentionState::Done,
        KeptAttentionState::Error => AttentionState::Error,
    }
}

fn osc(title: &str, body: Option<&str>) -> OscNotification {
    OscNotification {
        title: title.to_owned(),
        body: body.map(str::to_owned),
    }
}

fn kitty_chunk(id: &str, done: bool, part: KittyPart, text: &str) -> KittyChunk {
    KittyChunk {
        id: id.to_owned(),
        done,
        part,
        text: text.to_owned(),
    }
}

fn decode(encoded: &str) -> Option<String> {
    let bytes = STANDARD.decode(encoded).ok()?;
    String::from_utf8(bytes).ok()
}

#[test]
fn keeps_a_wait_already_showing_when_a_soft_wait_arrives_and_takes_it_when_idle() {
    let question = pane_with(AttentionState::Waiting, true, Some("Which database?"), 50.0);
    assert_eq!(
        reduce(
            &question,
            soft_set(AttentionState::Waiting, "Needs permission")
        ),
        question
    );
    let taken = reduce(
        &EMPTY_ATTENTION,
        soft_set(AttentionState::Waiting, "Needs permission"),
    );
    assert_eq!(taken.state, AttentionState::Waiting);
    assert_eq!(taken.message.as_deref(), Some("Needs permission"));
}

#[test]
fn follows_a_question_through_its_late_permission_notification_and_back_to_working() {
    let events = [
        claude_attention(
            ClaudeAttentionEvent::PreToolUse,
            &json!({
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{ "question": "Which database?" }] },
            })
            .to_string(),
        ),
        claude_attention(
            ClaudeAttentionEvent::Notification,
            &json!({
                "notification_type": "permission_prompt",
                "message": "Claude needs your permission",
            })
            .to_string(),
        ),
        claude_attention(
            ClaudeAttentionEvent::PostToolUse,
            &json!({ "tool_name": "AskUserQuestion" }).to_string(),
        ),
    ];
    let mut shown = Vec::new();
    let mut current = EMPTY_ATTENTION;
    for attention in events.into_iter().flatten() {
        let message = (!attention.message.is_empty()).then_some(attention.message);
        current = reduce(
            &current,
            AttentionEvent::Set {
                state: from_kept(attention.state),
                message,
                soft: attention.soft,
                at: AT,
            },
        );
        shown.push((current.state, current.message.clone()));
    }
    assert_eq!(
        shown,
        vec![
            (AttentionState::Waiting, Some("Which database?".to_owned())),
            (AttentionState::Waiting, Some("Which database?".to_owned())),
            (AttentionState::Working, None),
        ]
    );
}

#[test]
fn marks_a_pane_unread_when_set_to_waiting_done_or_error_keeping_the_message() {
    for state in [
        AttentionState::Waiting,
        AttentionState::Done,
        AttentionState::Error,
    ] {
        assert_eq!(
            reduce(&EMPTY_ATTENTION, set(state, Some("hi"))),
            pane_with(state, true, Some("hi"), AT),
            "{state:?}"
        );
    }
}

#[test]
fn does_not_raise_unread_for_working_and_clears_everything_on_none() {
    assert!(!reduce(&EMPTY_ATTENTION, set(AttentionState::Working, None)).unread);
    let cleared = reduce(
        &pane_with(AttentionState::Error, true, Some("x"), 0.0),
        set(AttentionState::None, None),
    );
    assert_eq!(cleared, pane_with(AttentionState::None, false, None, AT));
}

#[test]
fn keeps_the_previous_message_when_the_same_state_is_set_again_without_one() {
    let prev = pane_with(AttentionState::Waiting, true, Some("approve?"), 0.0);
    assert_eq!(
        reduce(&prev, set(AttentionState::Waiting, None))
            .message
            .as_deref(),
        Some("approve?")
    );
    assert_eq!(reduce(&prev, set(AttentionState::Done, None)).message, None);
}

#[test]
fn turns_a_terminal_notification_into_waiting_and_unread_or_only_unread_for_ostia_notify() {
    let from_osc = reduce(&EMPTY_ATTENTION, notify("m", true));
    assert_eq!(from_osc.state, AttentionState::Waiting);
    assert!(from_osc.unread);
    assert_eq!(from_osc.message.as_deref(), Some("m"));
    let from_cli = reduce(&pane(AttentionState::Working, false), notify("m", false));
    assert_eq!(from_cli.state, AttentionState::Working);
    assert!(from_cli.unread);
}

#[test]
fn keeps_the_message_a_waiting_pane_waits_with_when_a_non_waiting_notification_arrives() {
    let waiting = pane_with(AttentionState::Waiting, false, Some("approve?"), 0.0);
    assert_eq!(
        reduce(&waiting, notify("other", false)),
        pane_with(AttentionState::Waiting, true, Some("approve?"), AT)
    );
}

#[test]
fn replaces_the_message_when_an_already_waiting_pane_signals_a_new_wait() {
    let waiting = pane_with(AttentionState::Waiting, false, Some("approve?"), 0.0);
    assert_eq!(
        reduce(&waiting, notify("now this?", true)),
        pane_with(AttentionState::Waiting, true, Some("now this?"), AT)
    );
}

#[test]
fn treats_a_bell_as_unread_without_changing_the_state() {
    let rung = reduce(
        &pane(AttentionState::Done, false),
        AttentionEvent::Bell { at: AT },
    );
    assert_eq!(rung.state, AttentionState::Done);
    assert!(rung.unread);
}

#[test]
fn marks_a_failed_command_as_error_and_a_long_successful_one_as_done() {
    let failed = reduce(&EMPTY_ATTENTION, command_end(2, false));
    assert_eq!(failed.state, AttentionState::Error);
    assert!(failed.unread);
    let long = reduce(&EMPTY_ATTENTION, command_end(0, true));
    assert_eq!(long.state, AttentionState::Done);
    assert!(long.unread);
    let idle = EMPTY_ATTENTION;
    assert_eq!(reduce(&idle, command_end(0, false)), idle);
}

#[test]
fn ends_waiting_when_the_command_that_waited_exits_quietly() {
    let waiting = pane_with(AttentionState::Waiting, true, Some("Allow Bash?"), 0.0);
    assert_eq!(
        reduce(&waiting, command_end(0, false)),
        pane_with(AttentionState::None, false, None, AT)
    );
    let failed = reduce(&waiting, command_end(130, false));
    assert_eq!(failed.state, AttentionState::Error);
    assert!(failed.unread);
    let long = reduce(&waiting, command_end(0, true));
    assert_eq!(long.state, AttentionState::Done);
    assert!(long.unread);
}

#[test]
fn ends_working_when_the_command_that_reported_it_exits_quietly_and_keeps_done() {
    let working = pane(AttentionState::Working, false);
    assert_eq!(
        reduce(&working, command_end(0, false)),
        pane_with(AttentionState::None, false, None, AT)
    );
    let done = pane(AttentionState::Done, true);
    assert_eq!(reduce(&done, command_end(0, false)), done);
}

#[test]
fn wait_ended_clears_only_waiting() {
    let ended = AttentionEvent::WaitEnded { at: AT };
    assert_eq!(
        reduce(&pane(AttentionState::Waiting, true), ended.clone()),
        pane_with(AttentionState::None, false, None, AT)
    );
    for state in [
        AttentionState::None,
        AttentionState::Working,
        AttentionState::Done,
        AttentionState::Error,
    ] {
        let prev = pane_with(state, true, Some("m"), 0.0);
        assert_eq!(reduce(&prev, ended.clone()), prev, "{state:?}");
    }
}

#[test]
fn clears_a_stale_agent_state_when_a_new_command_starts_keeping_unread() {
    let start = AttentionEvent::CommandStart { at: AT };
    let next = reduce(&pane(AttentionState::Error, true), start.clone());
    assert_eq!(next.state, AttentionState::None);
    assert!(next.unread);
    assert_eq!(
        reduce(&pane(AttentionState::Waiting, true), start).state,
        AttentionState::None
    );
}

#[test]
fn drops_waiting_once_the_user_types_into_the_pane() {
    let input = AttentionEvent::Input { at: AT };
    assert_eq!(
        reduce(&pane(AttentionState::Waiting, false), input.clone()).state,
        AttentionState::None
    );
    let done = pane(AttentionState::Done, false);
    assert_eq!(reduce(&done, input), done);
}

#[test]
fn viewing_clears_unread_and_demotes_done_to_none_but_keeps_waiting_and_error() {
    let view = AttentionEvent::View { at: AT };
    let done = reduce(&pane(AttentionState::Done, true), view.clone());
    assert_eq!(done.state, AttentionState::None);
    assert!(!done.unread);
    let waiting = reduce(&pane(AttentionState::Waiting, true), view.clone());
    assert_eq!(waiting.state, AttentionState::Waiting);
    assert!(!waiting.unread);
    assert_eq!(
        reduce(&pane(AttentionState::Error, true), view.clone()).state,
        AttentionState::Error
    );
    let quiet = pane(AttentionState::Working, false);
    assert_eq!(reduce(&quiet, view), quiet);
}

#[test]
fn carries_the_message_of_a_failed_or_long_command() {
    let end = |exit_code, long| AttentionEvent::CommandEnd {
        exit_code,
        long,
        message: Some("cargo test".to_owned()),
        at: AT,
    };
    assert_eq!(
        reduce(&EMPTY_ATTENTION, end(1, false)),
        pane_with(AttentionState::Error, true, Some("cargo test"), AT)
    );
    assert_eq!(
        reduce(&EMPTY_ATTENTION, end(0, true)),
        pane_with(AttentionState::Done, true, Some("cargo test"), AT)
    );
}

#[test]
fn a_new_command_on_a_pane_with_no_state_changes_nothing() {
    let quiet = pane(AttentionState::None, true);
    assert_eq!(
        reduce(&quiet, AttentionEvent::CommandStart { at: AT }),
        quiet
    );
}

#[test]
fn needs_you_is_true_only_for_an_unread_waiting_or_error_pane() {
    assert!(needs_you(Some(&pane(AttentionState::Waiting, true))));
    assert!(needs_you(Some(&pane(AttentionState::Error, true))));
    assert!(!needs_you(Some(&pane(AttentionState::Waiting, false))));
    assert!(!needs_you(Some(&pane(AttentionState::Done, true))));
    assert!(!needs_you(None));
}

#[test]
fn tab_mark_marks_a_waiting_pane_whether_or_not_it_was_viewed() {
    assert_eq!(
        tab_mark(Some(&pane(AttentionState::Waiting, true))),
        Some(TabMark::Waiting)
    );
    assert_eq!(
        tab_mark(Some(&pane(AttentionState::Waiting, false))),
        Some(TabMark::Waiting)
    );
}

#[test]
fn tab_mark_marks_error_done_and_plain_notifications_only_while_unread() {
    assert_eq!(
        tab_mark(Some(&pane(AttentionState::Error, true))),
        Some(TabMark::Error)
    );
    assert_eq!(
        tab_mark(Some(&pane(AttentionState::Done, true))),
        Some(TabMark::Done)
    );
    assert_eq!(
        tab_mark(Some(&pane(AttentionState::None, true))),
        Some(TabMark::Unread)
    );
    assert_eq!(tab_mark(Some(&pane(AttentionState::Error, false))), None);
    assert_eq!(tab_mark(Some(&pane(AttentionState::None, false))), None);
    assert_eq!(tab_mark(None), None);
}

#[test]
fn pane_live_state_prefers_an_explicit_attention_state_over_the_running_flag() {
    assert_eq!(pane_live_state(None, true), WorkspaceLiveState::Working);
    assert_eq!(pane_live_state(None, false), WorkspaceLiveState::Idle);
    assert_eq!(
        pane_live_state(Some(&pane(AttentionState::Done, false)), true),
        WorkspaceLiveState::Done
    );
    assert_eq!(
        pane_live_state(Some(&pane(AttentionState::None, false)), true),
        WorkspaceLiveState::Working
    );
}

#[test]
fn aggregate_workspace_state_ranks_waiting_over_error_over_working_over_done_over_idle() {
    use WorkspaceLiveState::{Done, Error, Idle, Waiting, Working};
    assert_eq!(aggregate_workspace_state(&[]), Idle);
    assert_eq!(aggregate_workspace_state(&[Idle, Working]), Working);
    assert_eq!(aggregate_workspace_state(&[Working, Done]), Working);
    assert_eq!(aggregate_workspace_state(&[Idle, Done]), Done);
    assert_eq!(aggregate_workspace_state(&[Done, Error, Working]), Error);
    assert_eq!(aggregate_workspace_state(&[Error, Waiting, Done]), Waiting);
}

fn unread_panes() -> HashMap<String, PaneAttention> {
    let unread = |unread, at| pane_with(AttentionState::None, unread, None, at);
    HashMap::from([
        ("p1".to_owned(), unread(true, 5.0)),
        ("p2".to_owned(), unread(true, 9.0)),
        ("p3".to_owned(), unread(false, 20.0)),
        ("gone".to_owned(), unread(true, 99.0)),
    ])
}

#[test]
fn counts_unread_panes_among_the_given_ids() {
    let by_pane = unread_panes();
    assert_eq!(unread_count(&by_pane, ["p1", "p2", "p3"]), 2);
    assert_eq!(unread_count(&by_pane, ["p3"]), 0);
    assert_eq!(unread_count(&by_pane, ["missing"]), 0);
}

#[test]
fn picks_the_most_recent_unread_pane_that_still_exists() {
    let by_pane = unread_panes();
    assert_eq!(
        latest_unread(&by_pane, ["p1", "p2", "p3"]),
        Some("p2".to_owned())
    );
    assert_eq!(latest_unread(&by_pane, ["p3"]), None);
}

#[test]
fn returns_the_newest_waiting_signal_time_among_the_given_panes_or_0() {
    let waiting = |state, at| pane_with(state, false, None, at);
    let by_pane = HashMap::from([
        ("p1".to_owned(), waiting(AttentionState::Waiting, 5.0)),
        ("p2".to_owned(), waiting(AttentionState::Waiting, 9.0)),
        ("p3".to_owned(), waiting(AttentionState::Error, 20.0)),
        ("gone".to_owned(), waiting(AttentionState::Waiting, 99.0)),
    ]);
    assert_eq!(latest_waiting_at(&by_pane, ["p1", "p2", "p3"]), 9.0);
    assert_eq!(latest_waiting_at(&by_pane, ["p3"]), 0.0);
}

#[test]
fn reads_osc_9_as_a_message_but_ignores_conemu_subcommands_like_progress() {
    assert_eq!(
        parse_osc9("build finished"),
        Some(osc("build finished", None))
    );
    assert_eq!(parse_osc9("4;1;50"), None);
    assert_eq!(parse_osc9("9;/home/me"), None);
    assert_eq!(parse_osc9("  "), None);
}

#[test]
fn treats_conemu_subcommands_1_to_12_as_progress_and_anything_else_as_a_message() {
    for data in ["1", "9", "10;x", "11", "12;x"] {
        assert_eq!(parse_osc9(data), None, "{data}");
    }
    for data in ["13", "0;x", "123"] {
        assert_eq!(parse_osc9(data), Some(osc(data, None)), "{data}");
    }
    assert_eq!(parse_osc9("  hi "), Some(osc("hi", None)));
}

#[test]
fn reads_osc_777_notify_with_title_and_body() {
    assert_eq!(
        parse_osc777("notify;Tests;all 42 passed"),
        Some(osc("Tests", Some("all 42 passed")))
    );
    assert_eq!(
        parse_osc777("notify;Only title"),
        Some(osc("Only title", None))
    );
    assert_eq!(
        parse_osc777("notify;;body only"),
        Some(osc("body only", None))
    );
    assert_eq!(parse_osc777("notify;a;b;c"), Some(osc("a", Some("b;c"))));
    assert_eq!(parse_osc777("preexec;x"), None);
}

#[test]
fn reads_an_empty_osc_777_notify_as_nothing() {
    assert_eq!(parse_osc777("notify"), None);
    assert_eq!(parse_osc777("notify;"), None);
    assert_eq!(parse_osc777("notify; ; "), None);
    assert_eq!(parse_osc777("notify;t;"), Some(osc("t", None)));
}

#[test]
fn reads_kitty_osc_99_chunks_including_base64_payloads() {
    assert_eq!(
        parse_osc99(";hello", decode),
        Some(kitty_chunk("0", true, KittyPart::Title, "hello"))
    );
    assert_eq!(
        parse_osc99("i=1:d=0:p=body;text", decode),
        Some(kitty_chunk("1", false, KittyPart::Body, "text"))
    );
    assert_eq!(
        parse_osc99("e=1;aMOp", decode).map(|chunk| chunk.text),
        Some("hé".to_owned())
    );
    assert_eq!(parse_osc99("p=icon;x", decode), None);
    assert_eq!(parse_osc99("no-separator", decode), None);
}

#[test]
fn drops_a_kitty_chunk_whose_payload_does_not_decode() {
    assert_eq!(parse_osc99("e=1;!!!", decode), None);
}

#[test]
fn assembles_multi_chunk_kitty_notifications_until_d_is_1() {
    let mut kitty = KittyNotificationAssembler::default();
    assert_eq!(
        kitty.push(kitty_chunk("7", false, KittyPart::Title, "Deploy")),
        None
    );
    assert_eq!(
        kitty.push(kitty_chunk("7", true, KittyPart::Body, "ready")),
        Some(osc("Deploy", Some("ready")))
    );
    assert_eq!(
        kitty.push(kitty_chunk("8", true, KittyPart::Title, "")),
        None
    );
}

#[test]
fn formats_a_notification_into_a_single_message_line() {
    assert_eq!(notification_message(&osc("a", None)), "a");
    assert_eq!(notification_message(&osc("a", Some("b"))), "a: b");
}
