#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_work::{
    AGENT_BUSY_REASONS, AgentBusyReason, CLAUDE_WORK_EVENTS, ClaudeWorkEvent, claude_work_report,
    is_agent_busy_reason, is_claude_work_event, normalize_work_report,
};
use serde_json::{Value, json};

fn report(event: ClaudeWorkEvent, payload: Value) -> Value {
    serde_json::to_value(claude_work_report(event, &payload.to_string())).unwrap()
}

#[test]
fn names_the_subagent_a_subagent_start_hook_started() {
    assert_eq!(
        report(
            ClaudeWorkEvent::SubagentStart,
            json!({ "agent_id": "agent-1", "agent_type": "Explore" })
        ),
        json!({ "subagentStarted": "agent-1" })
    );
}

#[test]
fn counts_the_background_tasks_and_scheduled_wake_ups_a_stop_hook_lists() {
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({
                "background_tasks": [
                    { "id": "t1", "type": "shell", "status": "running", "command": "tail -f log" },
                    { "id": "t2", "type": "subagent", "status": "running" },
                    { "id": "t3", "type": "shell", "status": "completed" },
                ],
                "session_crons": [{ "id": "c1", "schedule": "*/5 * * * *", "recurring": true }],
            })
        ),
        json!({ "turnEnded": true, "tasks": 2, "scheduled": 1 })
    );
}

#[test]
fn reports_an_idle_session_when_a_stop_hook_lists_nothing_in_flight() {
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({ "background_tasks": [], "session_crons": [] })
        ),
        json!({ "turnEnded": true, "tasks": 0, "scheduled": 0 })
    );
}

#[test]
fn leaves_the_counts_out_when_the_hook_has_no_task_registry_to_read() {
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({ "last_assistant_message": "done" })
        ),
        json!({ "turnEnded": true })
    );
    assert_eq!(
        serde_json::to_value(claude_work_report(ClaudeWorkEvent::Stop, "not json")).unwrap(),
        json!({ "turnEnded": true })
    );
}

#[test]
fn does_not_count_the_subagent_that_is_stopping_among_the_tasks_still_running() {
    assert_eq!(
        report(
            ClaudeWorkEvent::SubagentStop,
            json!({
                "agent_id": "agent-1",
                "background_tasks": [
                    { "id": "agent-1", "type": "subagent", "status": "running" },
                    { "id": "t9", "type": "shell", "status": "running" },
                ],
                "session_crons": [],
            })
        ),
        json!({ "subagentStopped": "agent-1", "tasks": 1, "scheduled": 0 })
    );
}

#[test]
fn keeps_only_well_formed_fields_of_what_a_pane_sent() {
    assert_eq!(
        serde_json::to_value(normalize_work_report(&json!({
            "subagentStarted": "a",
            "subagentStopped": 7,
            "turnEnded": "yes",
            "tasks": -1,
            "scheduled": 2,
            "extra": true,
        })))
        .unwrap(),
        json!({ "subagentStarted": "a", "scheduled": 2 })
    );
    assert_eq!(
        serde_json::to_value(normalize_work_report(&Value::Null)).unwrap(),
        json!({})
    );
}

#[test]
fn writes_the_fields_of_a_report_in_the_order_ts_builds_them() {
    let stop = claude_work_report(
        ClaudeWorkEvent::Stop,
        r#"{"background_tasks":[],"session_crons":[]}"#,
    );
    assert_eq!(
        serde_json::to_string(&stop).unwrap(),
        r#"{"turnEnded":true,"tasks":0,"scheduled":0}"#
    );
    let stopped = claude_work_report(
        ClaudeWorkEvent::SubagentStop,
        r#"{"agent_id":"a","background_tasks":[],"session_crons":[]}"#,
    );
    assert_eq!(
        serde_json::to_string(&stopped).unwrap(),
        r#"{"subagentStopped":"a","tasks":0,"scheduled":0}"#
    );
    let all = normalize_work_report(&json!({
        "scheduled": 1,
        "tasks": 2,
        "turnEnded": true,
        "subagentStopped": "b",
        "subagentStarted": "a",
    }));
    assert_eq!(
        serde_json::to_string(&all).unwrap(),
        r#"{"subagentStarted":"a","subagentStopped":"b","turnEnded":true,"tasks":2,"scheduled":1}"#
    );
}

#[test]
fn names_a_subagent_with_no_usable_id_subagent_and_cuts_a_long_id_to_two_hundred() {
    for payload in [
        json!({}),
        json!({ "agent_id": "" }),
        json!({ "agent_id": 5 }),
        json!({ "agent_id": null }),
    ] {
        assert_eq!(
            report(ClaudeWorkEvent::SubagentStart, payload.clone()),
            json!({ "subagentStarted": "subagent" }),
            "{payload}"
        );
    }
    let long = "x".repeat(250);
    assert_eq!(
        report(ClaudeWorkEvent::SubagentStart, json!({ "agent_id": long })),
        json!({ "subagentStarted": "x".repeat(200) })
    );
    assert_eq!(
        serde_json::to_value(normalize_work_report(
            &json!({ "subagentStopped": "", "subagentStarted": "y".repeat(300) })
        ))
        .unwrap(),
        json!({ "subagentStarted": "y".repeat(200), "subagentStopped": "subagent" })
    );
}

#[test]
fn treats_every_ended_task_status_as_not_in_flight() {
    for status in [
        "completed",
        "failed",
        "killed",
        "stopped",
        "cancelled",
        "canceled",
    ] {
        assert_eq!(
            report(
                ClaudeWorkEvent::Stop,
                json!({ "background_tasks": [{ "id": "t", "status": status }] })
            ),
            json!({ "turnEnded": true, "tasks": 0 }),
            "{status}"
        );
    }
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({ "background_tasks": [
                { "id": "a", "status": "running" },
                { "id": "b" },
                { "id": "c", "status": 7 },
                { "id": "d", "status": "Completed" },
                "text",
                null,
            ] })
        ),
        json!({ "turnEnded": true, "tasks": 6 })
    );
}

#[test]
fn reads_a_registry_that_is_not_a_list_as_no_registry() {
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({ "background_tasks": {}, "session_crons": "x" })
        ),
        json!({ "turnEnded": true })
    );
    assert_eq!(
        report(
            ClaudeWorkEvent::Stop,
            json!({ "background_tasks": null, "session_crons": [1, 2, 3] })
        ),
        json!({ "turnEnded": true, "scheduled": 3 })
    );
}

#[test]
fn counts_a_stopping_subagent_by_its_id_only_on_subagent_stop() {
    let payload = json!({
        "agent_id": "agent-1",
        "background_tasks": [{ "id": "agent-1", "status": "running" }],
    });
    assert_eq!(
        report(ClaudeWorkEvent::SubagentStop, payload.clone()),
        json!({ "subagentStopped": "agent-1", "tasks": 0 })
    );
    assert_eq!(
        report(ClaudeWorkEvent::Stop, payload),
        json!({ "turnEnded": true, "tasks": 1 })
    );
    assert_eq!(
        report(
            ClaudeWorkEvent::SubagentStop,
            json!({ "background_tasks": [{ "id": "subagent", "status": "running" }] })
        ),
        json!({ "subagentStopped": "subagent", "tasks": 0 })
    );
}

#[test]
fn reads_a_payload_that_is_not_an_object_as_an_empty_payload() {
    for raw in ["[1]", "5", "\"x\"", "null", "true", ""] {
        assert_eq!(
            serde_json::to_value(claude_work_report(ClaudeWorkEvent::Stop, raw)).unwrap(),
            json!({ "turnEnded": true }),
            "{raw}"
        );
        assert_eq!(
            serde_json::to_value(claude_work_report(ClaudeWorkEvent::SubagentStart, raw)).unwrap(),
            json!({ "subagentStarted": "subagent" }),
            "{raw}"
        );
    }
}

#[test]
fn keeps_a_count_that_is_a_whole_number_up_to_ten_thousand() {
    for (tasks, expected) in [
        (json!(0), Some(0)),
        (json!(3), Some(3)),
        (json!(3.0), Some(3)),
        (json!(10_000), Some(10_000)),
        (json!(10_001), Some(10_000)),
        (json!(1e30), Some(10_000)),
        (json!(1.5), None),
        (json!(-1), None),
        (json!("3"), None),
        (json!(null), None),
        (json!(true), None),
    ] {
        let report =
            serde_json::to_value(normalize_work_report(&json!({ "tasks": tasks }))).unwrap();
        let expected = expected.map_or_else(|| json!({}), |count| json!({ "tasks": count }));
        assert_eq!(report, expected, "{tasks}");
    }
}

#[test]
fn keeps_turn_ended_only_for_the_boolean_true() {
    for (value, kept) in [
        (json!(true), true),
        (json!(false), false),
        (json!("true"), false),
        (json!(1), false),
        (json!(null), false),
    ] {
        let report =
            serde_json::to_value(normalize_work_report(&json!({ "turnEnded": value }))).unwrap();
        let expected = if kept {
            json!({ "turnEnded": true })
        } else {
            json!({})
        };
        assert_eq!(report, expected, "{value}");
    }
    assert_eq!(
        serde_json::to_value(normalize_work_report(&json!([1, 2]))).unwrap(),
        json!({})
    );
    assert_eq!(
        serde_json::to_value(normalize_work_report(&json!("text"))).unwrap(),
        json!({})
    );
}

#[test]
fn knows_the_busy_reasons_and_the_hook_events_and_refuses_anything_else() {
    let reasons: Vec<&str> = AGENT_BUSY_REASONS
        .iter()
        .map(|reason| reason.as_str())
        .collect();
    assert_eq!(
        reasons,
        [
            "subagent",
            "background-task",
            "scheduled-task",
            "child-process",
            "unknown"
        ]
    );
    for reason in reasons {
        assert!(is_agent_busy_reason(&json!(reason)), "{reason}");
    }
    for value in [
        json!("Subagent"),
        json!("typed"),
        json!(5),
        json!(null),
        json!(["subagent"]),
    ] {
        assert!(!is_agent_busy_reason(&value), "{value}");
    }
    assert_eq!(AgentBusyReason::BackgroundTask.as_str(), "background-task");

    assert_eq!(
        CLAUDE_WORK_EVENTS,
        [
            ClaudeWorkEvent::SubagentStart,
            ClaudeWorkEvent::SubagentStop,
            ClaudeWorkEvent::Stop
        ]
    );
    for name in ["SubagentStart", "SubagentStop", "Stop"] {
        assert!(is_claude_work_event(&json!(name)), "{name}");
    }
    for value in [json!("stop"), json!("PreToolUse"), json!(1), json!(null)] {
        assert!(!is_claude_work_event(&value), "{value}");
    }
}
