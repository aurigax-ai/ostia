#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_stream::{
    PlanItem, PlanStatus, STREAM_TURNS_DEFAULT, STREAM_TURNS_MAX, StreamEnd, StreamEvent, TurnEnd,
    last_turns, turns_started,
};
use serde_json::json;

fn started(turn: &str) -> StreamEvent {
    StreamEvent::TurnStarted {
        turn: turn.to_owned(),
    }
}

fn text(turn: &str, id: &str) -> StreamEvent {
    StreamEvent::Text {
        turn: turn.to_owned(),
        id: id.to_owned(),
        text: "hi".to_owned(),
        append: false,
    }
}

fn history() -> Vec<StreamEvent> {
    vec![
        StreamEvent::Session {
            session: "s".to_owned(),
        },
        started("t1"),
        text("t1", "a"),
        StreamEvent::TurnEnded {
            turn: "t1".to_owned(),
            status: TurnEnd::Done,
        },
        started("t2"),
        text("t2", "b"),
        started("t3"),
        StreamEvent::Live,
    ]
}

#[test]
fn counts_the_turn_started_events() {
    assert_eq!(turns_started(&[]), 0);
    assert_eq!(turns_started(&[StreamEvent::Live, text("t", "a")]), 0);
    assert_eq!(turns_started(&history()), 3);
}

#[test]
fn keeps_everything_from_the_start_of_the_last_n_turns() {
    let events = history();
    assert_eq!(last_turns(&events, 1), events[6..]);
    assert_eq!(last_turns(&events, 2), events[4..]);
    assert_eq!(last_turns(&events, 3), events[0..]);
}

#[test]
fn keeps_the_whole_list_when_n_turns_reach_or_pass_the_turns_there_are() {
    let events = history();
    assert_eq!(last_turns(&events, 4), events);
    assert_eq!(last_turns(&events, 50), events);
    assert_eq!(last_turns(&[], 5), Vec::<StreamEvent>::new());
    let no_turns = vec![StreamEvent::Live, text("t", "a")];
    assert_eq!(last_turns(&no_turns, 1), no_turns);
}

#[test]
fn keeps_the_whole_list_for_zero_turns_as_ts_does() {
    let events = history();
    assert_eq!(last_turns(&events, 0), events);
}

#[test]
fn keeps_the_stream_limits() {
    assert_eq!(STREAM_TURNS_MAX, 50);
    assert_eq!(STREAM_TURNS_DEFAULT, 5);
}

#[test]
fn writes_each_event_in_the_wire_shape_of_ts() {
    let table = [
        (
            started("t1"),
            json!({ "type": "turn.started", "turn": "t1" }),
        ),
        (
            StreamEvent::TurnEnded {
                turn: "t1".to_owned(),
                status: TurnEnd::Interrupted,
            },
            json!({ "type": "turn.ended", "turn": "t1", "status": "interrupted" }),
        ),
        (
            text("t1", "a"),
            json!({ "type": "text", "turn": "t1", "id": "a", "text": "hi" }),
        ),
        (
            StreamEvent::Text {
                turn: "t1".to_owned(),
                id: "a".to_owned(),
                text: "hi".to_owned(),
                append: true,
            },
            json!({ "type": "text", "turn": "t1", "id": "a", "text": "hi", "append": true }),
        ),
        (
            StreamEvent::Plan {
                turn: "t1".to_owned(),
                id: "p".to_owned(),
                items: vec![PlanItem {
                    text: "x".to_owned(),
                    status: PlanStatus::Active,
                }],
                append: false,
            },
            json!({ "type": "plan", "turn": "t1", "id": "p", "items": [{ "text": "x", "status": "active" }] }),
        ),
        (
            StreamEvent::Session {
                session: "s".to_owned(),
            },
            json!({ "type": "session", "session": "s" }),
        ),
        (
            StreamEvent::Ask {
                ask_id: "k".to_owned(),
                kind: "permission".to_owned(),
            },
            json!({ "type": "ask", "askId": "k", "kind": "permission" }),
        ),
        (
            StreamEvent::AskResolved {
                ask_id: "k".to_owned(),
                outcome: "allowed".to_owned(),
            },
            json!({ "type": "ask.resolved", "askId": "k", "outcome": "allowed" }),
        ),
        (StreamEvent::Live, json!({ "type": "live" })),
        (
            StreamEvent::Ended {
                reason: StreamEnd::PaneClosed,
            },
            json!({ "type": "ended", "reason": "pane-closed" }),
        ),
        (
            StreamEvent::Ended {
                reason: StreamEnd::OutOfScope,
            },
            json!({ "type": "ended", "reason": "out-of-scope" }),
        ),
    ];
    for (event, expected) in table {
        assert_eq!(serde_json::to_value(&event).unwrap(), expected, "{event:?}");
    }
}
