#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_stop::{AGENT_HOOK_INPUT_MAX, AgentStop, HookAgent, parse_agent_stop};
use serde_json::{Map, Value, json};

const SESSION: &str = "0f6b2a3c-aaaa-4bbb-8ccc-0123456789ab";

fn claude_stop(extra: Value) -> String {
    let mut payload = json!({
        "session_id": SESSION,
        "transcript_path": "/home/u/.claude/projects/x/0f6b2a3c.jsonl",
        "cwd": "/home/u/proj",
        "hook_event_name": "Stop",
        "stop_hook_active": false,
        "last_assistant_message": "Done. All tests pass.",
    });
    let extra: Map<String, Value> = serde_json::from_value(extra).unwrap();
    payload.as_object_mut().unwrap().extend(extra);
    payload.to_string()
}

fn codex_stop() -> String {
    json!({
        "session_id": "019a-codex-session",
        "turn_id": "turn-7",
        "cwd": "/home/u/proj",
        "hook_event_name": "Stop",
        "model": "gpt-5",
        "last_assistant_message": "Reviewed: VERDICT pass",
    })
    .to_string()
}

#[test]
fn grf_c129_reads_the_session_and_closing_message_of_claude_code_and_codex() {
    assert_eq!(
        parse_agent_stop(HookAgent::Claude, &claude_stop(json!({}))),
        Some(AgentStop {
            session_id: SESSION.to_owned(),
            turn_id: None,
            message: Some("Done. All tests pass.".to_owned()),
            background_work: false,
        })
    );
    assert_eq!(
        parse_agent_stop(HookAgent::Codex, &codex_stop()),
        Some(AgentStop {
            session_id: "019a-codex-session".to_owned(),
            turn_id: Some("turn-7".to_owned()),
            message: Some("Reviewed: VERDICT pass".to_owned()),
            background_work: false,
        })
    );
    let tasks = claude_stop(json!({ "background_tasks": [{ "id": "b1", "status": "running" }] }));
    assert!(
        parse_agent_stop(HookAgent::Claude, &tasks)
            .unwrap()
            .background_work
    );
    let crons = claude_stop(json!({ "session_crons": [{ "id": "c1" }] }));
    assert!(
        parse_agent_stop(HookAgent::Claude, &crons)
            .unwrap()
            .background_work
    );
}

#[test]
fn grf_c130_no_message_without_the_field_and_nothing_from_bad_or_large_input() {
    let mut payload: Map<String, Value> = serde_json::from_str(&claude_stop(json!({}))).unwrap();
    payload.remove("last_assistant_message");
    let without = parse_agent_stop(HookAgent::Claude, &Value::Object(payload).to_string()).unwrap();
    assert_eq!(without.message, None);
    assert_eq!(without.session_id, SESSION);
    assert_eq!(parse_agent_stop(HookAgent::Claude, "not json"), None);
    let padded = claude_stop(json!({ "pad": "x".repeat(AGENT_HOOK_INPUT_MAX) }));
    assert_eq!(parse_agent_stop(HookAgent::Claude, &padded), None);
}

#[test]
fn refuses_a_payload_that_is_not_an_object_or_has_a_bad_session_id() {
    assert_eq!(parse_agent_stop(HookAgent::Claude, "[1]"), None);
    assert_eq!(parse_agent_stop(HookAgent::Claude, "{}"), None);
    for id in ["", "-x", "a b", &"a".repeat(129)] {
        let raw = json!({ "session_id": id }).to_string();
        assert_eq!(parse_agent_stop(HookAgent::Claude, &raw), None, "{id}");
    }
}

#[test]
fn takes_the_prompt_id_when_there_is_no_turn_id_and_drops_a_blank_message() {
    let raw = json!({ "session_id": "s-1", "prompt_id": "p-1", "last_assistant_message": " \n " })
        .to_string();
    let stop = parse_agent_stop(HookAgent::Codex, &raw).unwrap();
    assert_eq!(stop.turn_id.as_deref(), Some("p-1"));
    assert_eq!(stop.message, None);
}
