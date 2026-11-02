#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::KeptAttentionState;
use ostia_contract::claude_attention::{
    ClaudeAttention, ClaudeAttentionEvent, claude_attention, is_claude_question_tool,
};
use serde_json::{Value, json};

fn attention(event: ClaudeAttentionEvent, payload: &Value) -> Option<ClaudeAttention> {
    claude_attention(event, &payload.to_string())
}

fn notification(payload: &Value) -> Option<ClaudeAttention> {
    attention(ClaudeAttentionEvent::Notification, payload)
}

fn plain(state: KeptAttentionState, message: &str) -> ClaudeAttention {
    ClaudeAttention {
        state,
        message: message.to_owned(),
        closing: None,
        soft: false,
    }
}

fn soft(message: &str) -> ClaudeAttention {
    ClaudeAttention {
        soft: true,
        ..plain(KeptAttentionState::Waiting, message)
    }
}

#[test]
fn marks_a_permission_prompt_as_waiting_with_its_message() {
    assert_eq!(
        notification(&json!({
            "notification_type": "permission_prompt",
            "message": "Claude needs your permission to use Bash",
        })),
        Some(soft("Claude needs your permission to use Bash"))
    );
}

#[test]
fn never_turns_the_idle_reminder_after_a_finished_turn_into_waiting() {
    assert_eq!(
        notification(&json!({
            "notification_type": "idle_prompt",
            "message": "Claude is waiting for your input",
        })),
        None
    );
    assert_eq!(
        notification(&json!({ "message": "Claude is waiting for your input" })),
        None
    );
}

#[test]
fn never_turns_a_finished_subagent_into_waiting_while_the_parent_still_works() {
    assert_eq!(
        notification(
            &json!({ "notification_type": "agent_completed", "message": "Agent finished" })
        ),
        None
    );
}

#[test]
fn keeps_an_unknown_notification_as_waiting() {
    assert_eq!(
        notification(&json!({ "notification_type": "elicitation_dialog", "message": "Pick one" })),
        Some(soft("Pick one"))
    );
}

#[test]
fn marks_a_question_or_a_plan_for_review_as_waiting_and_ignores_other_tools() {
    let question = json!({
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [{ "question": "Which database?" }] },
    });
    assert_eq!(
        attention(ClaudeAttentionEvent::PreToolUse, &question),
        Some(plain(KeptAttentionState::Waiting, "Which database?"))
    );
    assert_eq!(
        attention(
            ClaudeAttentionEvent::PreToolUse,
            &json!({ "tool_name": "ExitPlanMode" })
        ),
        Some(plain(KeptAttentionState::Waiting, "Plan ready for review"))
    );
    assert_eq!(
        attention(
            ClaudeAttentionEvent::PreToolUse,
            &json!({ "tool_name": "Bash" })
        ),
        None
    );
}

#[test]
fn keeps_the_question_when_claude_also_announces_a_permission_prompt_for_the_question_tool() {
    for tool in ["AskUserQuestion", "ExitPlanMode"] {
        assert_eq!(
            notification(&json!({
                "notification_type": "permission_prompt",
                "message": format!("Claude needs your permission to use {tool}"),
            })),
            None,
            "{tool}"
        );
    }
}

#[test]
fn returns_to_working_once_the_question_or_plan_is_answered_and_ignores_other_tools() {
    for tool in ["AskUserQuestion", "ExitPlanMode"] {
        assert_eq!(
            attention(
                ClaudeAttentionEvent::PostToolUse,
                &json!({ "tool_name": tool })
            ),
            Some(plain(KeptAttentionState::Working, "")),
            "{tool}"
        );
    }
    assert_eq!(
        attention(
            ClaudeAttentionEvent::PostToolUse,
            &json!({ "tool_name": "Bash" })
        ),
        None
    );
    assert!(is_claude_question_tool("ExitPlanMode"));
    assert!(!is_claude_question_tool("Bash"));
}

#[test]
fn ends_a_turn_as_done_and_a_failed_turn_as_an_error() {
    assert_eq!(
        claude_attention(ClaudeAttentionEvent::Stop, "{}"),
        Some(plain(KeptAttentionState::Done, ""))
    );
    let stop = json!({
        "session_id": "s-1",
        "last_assistant_message": "Merged the fix.\nLong report.",
    });
    assert_eq!(
        attention(ClaudeAttentionEvent::Stop, &stop),
        Some(ClaudeAttention {
            closing: Some("Merged the fix.".to_owned()),
            ..plain(KeptAttentionState::Done, "")
        })
    );
    assert_eq!(
        attention(
            ClaudeAttentionEvent::StopFailure,
            &json!({ "error": "rate_limit" })
        ),
        Some(plain(KeptAttentionState::Error, "rate_limit"))
    );
    assert_eq!(
        claude_attention(ClaudeAttentionEvent::StopFailure, "{}"),
        Some(plain(KeptAttentionState::Error, "Turn failed"))
    );
}

#[test]
fn turns_a_refused_action_into_waiting_that_names_the_tool_and_the_reason() {
    let denied = json!({
        "tool_name": "Bash",
        "tool_input": { "command": "git push --force token=abc" },
        "reason": "Force-push is not allowed\nsecond line",
    });
    assert_eq!(
        attention(ClaudeAttentionEvent::PermissionDenied, &denied),
        Some(plain(
            KeptAttentionState::Waiting,
            "Refused Bash: Force-push is not allowed"
        ))
    );
    assert_eq!(
        claude_attention(ClaudeAttentionEvent::PermissionDenied, "{}"),
        Some(plain(KeptAttentionState::Waiting, "Refused an action"))
    );
}

#[test]
fn survives_a_payload_that_is_not_json() {
    assert_eq!(
        claude_attention(ClaudeAttentionEvent::Notification, "not json"),
        Some(soft(""))
    );
    assert_eq!(claude_attention(ClaudeAttentionEvent::PreToolUse, ""), None);
}

#[test]
fn reads_only_the_six_known_event_names() {
    for name in [
        "Notification",
        "PreToolUse",
        "PostToolUse",
        "PermissionDenied",
        "Stop",
        "StopFailure",
    ] {
        assert!(ClaudeAttentionEvent::parse(name).is_some(), "{name}");
    }
    assert!(ClaudeAttentionEvent::parse("Nope").is_none());
}
