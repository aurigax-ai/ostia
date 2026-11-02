use serde_json::Value;

use crate::attention::KeptAttentionState;
use crate::hook_payload::{first_question, parse_payload, text};

pub const CODEX_QUESTION_TOOL: &str = "request_user_input";

static NULL: Value = Value::Null;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexAttentionEvent {
    PreToolUse,
    PostToolUse,
}

impl CodexAttentionEvent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexAttention {
    pub state: KeptAttentionState,
    pub message: String,
}

pub fn codex_attention(event: CodexAttentionEvent, raw: &str) -> Option<CodexAttention> {
    let payload = parse_payload(raw);
    if text(payload.get("tool_name").unwrap_or(&NULL)) != CODEX_QUESTION_TOOL {
        return None;
    }
    Some(match event {
        CodexAttentionEvent::PreToolUse => {
            let question = first_question(payload.get("tool_input").unwrap_or(&NULL));
            CodexAttention {
                state: KeptAttentionState::Waiting,
                message: if question.is_empty() {
                    "Has a question".to_owned()
                } else {
                    question
                },
            }
        }
        CodexAttentionEvent::PostToolUse => CodexAttention {
            state: KeptAttentionState::Working,
            message: String::new(),
        },
    })
}
