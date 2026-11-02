#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_attention::WorkspaceLiveState;
use ostia_control::events::{
    PLATFORM_EVENT_TYPES, PlatformEvent, PlatformEventType, PlatformEvents,
};

fn notify(title: &str, body: Option<&str>, from: &str) -> PlatformEvent {
    PlatformEvent::Notify {
        title: title.to_owned(),
        body: body.map(str::to_owned),
        from: from.to_owned(),
    }
}

fn session(id: &str) -> String {
    id.to_owned()
}

#[test]
fn delivers_an_emitted_payload_to_a_subscriber_of_the_same_type() {
    let events = PlatformEvents::default();
    let mut listener = events.subscribe_to(PlatformEventType::Notify);

    events.emit(notify("hi", Some("there"), "pane-1"));

    assert_eq!(
        listener.try_recv().unwrap(),
        notify("hi", Some("there"), "pane-1")
    );
}

#[test]
fn never_cross_delivers_to_a_listener_subscribed_to_a_different_type() {
    let events = PlatformEvents::default();
    let mut notify_listener = events.subscribe_to(PlatformEventType::Notify);
    let mut done_listener = events.subscribe_to(PlatformEventType::AgentDone);

    events.emit(notify("hi", None, "pane-1"));

    assert!(notify_listener.try_recv().is_ok());
    assert!(notify_listener.try_recv().is_err());
    assert!(done_listener.try_recv().is_err());
}

#[test]
fn is_a_no_op_when_nothing_is_subscribed_the_gateway_being_off_must_never_fail() {
    let events = PlatformEvents::default();
    events.emit(PlatformEvent::SessionState {
        session_id: session("s1"),
        state: WorkspaceLiveState::Idle,
    });
}

#[test]
fn stops_delivering_once_the_receiver_is_dropped() {
    let events = PlatformEvents::default();
    let dropped = events.subscribe_to(PlatformEventType::AgentNeedsInput);
    let mut kept = events.subscribe_to(PlatformEventType::AgentNeedsInput);
    drop(dropped);

    events.emit(PlatformEvent::AgentNeedsInput {
        session_id: session("s1"),
    });

    assert_eq!(
        kept.try_recv().unwrap(),
        PlatformEvent::AgentNeedsInput {
            session_id: session("s1")
        }
    );
    assert!(kept.try_recv().is_err());
}

#[test]
fn emit_session_state_fans_a_waiting_session_out_to_session_state_and_agent_needs_input() {
    let events = PlatformEvents::default();
    let mut state = events.subscribe_to(PlatformEventType::SessionState);
    let mut needs_input = events.subscribe_to(PlatformEventType::AgentNeedsInput);
    let mut done = events.subscribe_to(PlatformEventType::AgentDone);

    events.emit_session_state("s1", WorkspaceLiveState::Waiting);

    assert_eq!(
        state.try_recv().unwrap(),
        PlatformEvent::SessionState {
            session_id: session("s1"),
            state: WorkspaceLiveState::Waiting
        }
    );
    assert_eq!(
        needs_input.try_recv().unwrap(),
        PlatformEvent::AgentNeedsInput {
            session_id: session("s1")
        }
    );
    assert!(done.try_recv().is_err());
}

#[test]
fn emit_session_state_emits_agent_done_for_done_and_no_agent_event_for_working() {
    let events = PlatformEvents::default();
    let mut needs_input = events.subscribe_to(PlatformEventType::AgentNeedsInput);
    let mut done = events.subscribe_to(PlatformEventType::AgentDone);

    events.emit_session_state("s1", WorkspaceLiveState::Done);
    events.emit_session_state("s1", WorkspaceLiveState::Working);

    assert_eq!(
        done.try_recv().unwrap(),
        PlatformEvent::AgentDone {
            session_id: session("s1")
        }
    );
    assert!(done.try_recv().is_err());
    assert!(needs_input.try_recv().is_err());
}

#[test]
fn platform_event_types_lists_exactly_the_8_event_types_this_bus_carries() {
    let mut names: Vec<&str> = PLATFORM_EVENT_TYPES
        .iter()
        .map(|kind| kind.as_str())
        .collect();
    names.sort_unstable();
    let mut expected = vec![
        "notify",
        "agent.needs-input",
        "agent.done",
        "session.state",
        "pane.state",
        "ask.created",
        "ask.resolved",
        "artifact.changed",
    ];
    expected.sort_unstable();
    assert_eq!(names, expected);
}

#[test]
fn keeps_the_order_of_events_for_one_subscriber() {
    let events = PlatformEvents::default();
    let mut state = events.subscribe_to(PlatformEventType::SessionState);

    events.emit_session_state("s1", WorkspaceLiveState::Working);
    events.emit_session_state("s1", WorkspaceLiveState::Waiting);
    events.emit_session_state("s1", WorkspaceLiveState::Done);

    let seen: Vec<WorkspaceLiveState> = std::iter::from_fn(|| state.try_recv().ok())
        .map(|event| match event {
            PlatformEvent::SessionState { state, .. } => state,
            other => panic!("unexpected event {other:?}"),
        })
        .collect();
    assert_eq!(
        seen,
        [
            WorkspaceLiveState::Working,
            WorkspaceLiveState::Waiting,
            WorkspaceLiveState::Done
        ]
    );
}
