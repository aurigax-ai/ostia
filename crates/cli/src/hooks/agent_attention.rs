use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::Value;

use super::hook_payload::{first_question, parse_payload, text};
use super::saved_attention::KeptAttentionState;

const CLAUDE_QUESTION_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];
const NOT_WAITING_NOTIFICATIONS: [&str; 2] = ["idle_prompt", "agent_completed"];
const CODEX_QUESTION_TOOL: &str = "request_user_input";

static IDLE_REMINDER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i-u)waiting for your input"));
static QUESTION_TOOL_PERMISSION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i-u)permission to use (?:AskUserQuestion|ExitPlanMode)\b"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeAttentionEvent {
    Notification,
    PreToolUse,
    PostToolUse,
    PermissionDenied,
    Stop,
    StopFailure,
}

impl ClaudeAttentionEvent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "Notification" => Some(Self::Notification),
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "PermissionDenied" => Some(Self::PermissionDenied),
            "Stop" => Some(Self::Stop),
            "StopFailure" => Some(Self::StopFailure),
            _ => None,
        }
    }
}

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
pub struct AgentAttention {
    pub state: KeptAttentionState,
    pub message: String,
}

pub fn claude_attention(event: ClaudeAttentionEvent, raw: &str) -> Option<AgentAttention> {
    let payload = parse_payload(raw);
    match event {
        ClaudeAttentionEvent::Notification => notification_attention(&payload),
        ClaudeAttentionEvent::PreToolUse => question_attention(&payload),
        ClaudeAttentionEvent::PostToolUse => {
            let tool = text(payload.get("tool_name"));
            CLAUDE_QUESTION_TOOLS
                .contains(&tool.as_str())
                .then(|| AgentAttention {
                    state: KeptAttentionState::Working,
                    message: String::new(),
                })
        }
        ClaudeAttentionEvent::PermissionDenied => Some(denied_attention(&payload)),
        ClaudeAttentionEvent::Stop => Some(AgentAttention {
            state: KeptAttentionState::Done,
            message: String::new(),
        }),
        ClaudeAttentionEvent::StopFailure => {
            let error = text(payload.get("error"));
            Some(AgentAttention {
                state: KeptAttentionState::Error,
                message: or_default(error, "Turn failed"),
            })
        }
    }
}

pub fn codex_attention(event: CodexAttentionEvent, raw: &str) -> Option<AgentAttention> {
    let payload = parse_payload(raw);
    if text(payload.get("tool_name")) != CODEX_QUESTION_TOOL {
        return None;
    }
    Some(match event {
        CodexAttentionEvent::PreToolUse => AgentAttention {
            state: KeptAttentionState::Waiting,
            message: or_default(first_question(payload.get("tool_input")), "Has a question"),
        },
        CodexAttentionEvent::PostToolUse => AgentAttention {
            state: KeptAttentionState::Working,
            message: String::new(),
        },
    })
}

fn notification_attention(payload: &Value) -> Option<AgentAttention> {
    let kind = text(payload.get("notification_type"));
    let message = text(payload.get("message"));
    if NOT_WAITING_NOTIFICATIONS.contains(&kind.as_str()) {
        return None;
    }
    if kind.is_empty() && IDLE_REMINDER.is_match(&message) {
        return None;
    }
    if QUESTION_TOOL_PERMISSION.is_match(&message) {
        return None;
    }
    Some(AgentAttention {
        state: KeptAttentionState::Waiting,
        message,
    })
}

fn question_attention(payload: &Value) -> Option<AgentAttention> {
    let message = match text(payload.get("tool_name")).as_str() {
        "AskUserQuestion" => {
            or_default(first_question(payload.get("tool_input")), "Has a question")
        }
        "ExitPlanMode" => "Plan ready for review".to_owned(),
        _ => return None,
    };
    Some(AgentAttention {
        state: KeptAttentionState::Waiting,
        message,
    })
}

fn denied_attention(payload: &Value) -> AgentAttention {
    let tool = text(payload.get("tool_name"));
    let reason = text(payload.get("reason"));
    let first_line = reason.split('\n').next().unwrap_or("");
    let subject = if tool.is_empty() {
        "Refused an action".to_owned()
    } else {
        format!("Refused {tool}")
    };
    let message = if first_line.is_empty() {
        subject
    } else {
        format!("{subject}: {first_line}")
    };
    AgentAttention {
        state: KeptAttentionState::Waiting,
        message,
    }
}

fn or_default(text: String, fallback: &str) -> String {
    if text.is_empty() {
        fallback.to_owned()
    } else {
        text
    }
}
