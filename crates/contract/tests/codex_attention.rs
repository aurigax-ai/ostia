#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::KeptAttentionState;
use ostia_contract::codex_attention::{CodexAttention, CodexAttentionEvent, codex_attention};
use serde_json::{Value, json};

fn call(tool: &str, input: Option<Value>) -> String {
    match input {
        Some(input) => json!({ "tool_name": tool, "tool_input": input }),
        None => json!({ "tool_name": tool }),
    }
    .to_string()
}

fn attention(state: KeptAttentionState, message: &str) -> Option<CodexAttention> {
    Some(CodexAttention {
        state,
        message: message.to_owned(),
    })
}

#[test]
fn waits_with_the_first_question_when_codex_asks_one() {
    let input = json!({ "questions": [{ "id": "db", "question": "Which database?" }] });
    assert_eq!(
        codex_attention(
            CodexAttentionEvent::PreToolUse,
            &call("request_user_input", Some(input))
        ),
        attention(KeptAttentionState::Waiting, "Which database?")
    );
}

#[test]
fn waits_with_a_generic_message_when_the_question_text_is_missing() {
    assert_eq!(
        codex_attention(
            CodexAttentionEvent::PreToolUse,
            &call("request_user_input", None)
        ),
        attention(KeptAttentionState::Waiting, "Has a question")
    );
}

#[test]
fn goes_back_to_working_once_the_question_is_answered() {
    assert_eq!(
        codex_attention(
            CodexAttentionEvent::PostToolUse,
            &call("request_user_input", None)
        ),
        attention(KeptAttentionState::Working, "")
    );
}

#[test]
fn ignores_every_other_tool_and_unreadable_input() {
    assert_eq!(
        codex_attention(CodexAttentionEvent::PreToolUse, &call("Bash", None)),
        None
    );
    assert_eq!(
        codex_attention(CodexAttentionEvent::PostToolUse, &call("update_plan", None)),
        None
    );
    assert_eq!(
        codex_attention(CodexAttentionEvent::PreToolUse, "not json"),
        None
    );
}

#[test]
fn reads_only_the_two_known_event_names() {
    assert!(CodexAttentionEvent::parse("PreToolUse").is_some());
    assert!(CodexAttentionEvent::parse("PostToolUse").is_some());
    assert!(CodexAttentionEvent::parse("Stop").is_none());
}
