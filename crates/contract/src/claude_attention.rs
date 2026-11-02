use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::{Map, Value};

use crate::attention::KeptAttentionState;
use crate::closing_line::closing_from_stop;
use crate::hook_payload::{first_question, parse_payload, text};

pub const CLAUDE_QUESTION_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

const NOT_WAITING_NOTIFICATIONS: [&str; 2] = ["idle_prompt", "agent_completed"];

static NULL: Value = Value::Null;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeAttention {
    pub state: KeptAttentionState,
    pub message: String,
    pub closing: Option<String>,
    pub soft: bool,
}

impl ClaudeAttention {
    fn of(state: KeptAttentionState, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
            closing: None,
            soft: false,
        }
    }
}

pub fn is_claude_question_tool(tool: &str) -> bool {
    CLAUDE_QUESTION_TOOLS.contains(&tool)
}

fn field_text(payload: &Map<String, Value>, key: &str) -> String {
    text(payload.get(key).unwrap_or(&NULL))
}

fn or_default(text: String, fallback: &str) -> String {
    if text.is_empty() {
        fallback.to_owned()
    } else {
        text
    }
}

fn notification_attention(payload: &Map<String, Value>) -> Option<ClaudeAttention> {
    let kind = field_text(payload, "notification_type");
    let message = field_text(payload, "message");
    if NOT_WAITING_NOTIFICATIONS.contains(&kind.as_str()) {
        return None;
    }
    if kind.is_empty() && IDLE_REMINDER.is_match(&message) {
        return None;
    }
    if QUESTION_TOOL_PERMISSION.is_match(&message) {
        return None;
    }
    Some(ClaudeAttention {
        soft: true,
        ..ClaudeAttention::of(KeptAttentionState::Waiting, message)
    })
}

fn question_attention(payload: &Map<String, Value>) -> Option<ClaudeAttention> {
    let message = match field_text(payload, "tool_name").as_str() {
        "AskUserQuestion" => or_default(
            first_question(payload.get("tool_input").unwrap_or(&NULL)),
            "Has a question",
        ),
        "ExitPlanMode" => "Plan ready for review".to_owned(),
        _ => return None,
    };
    Some(ClaudeAttention::of(KeptAttentionState::Waiting, message))
}

fn denied_attention(payload: &Map<String, Value>) -> ClaudeAttention {
    let tool = field_text(payload, "tool_name");
    let reason = field_text(payload, "reason");
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
    ClaudeAttention::of(KeptAttentionState::Waiting, message)
}

pub fn claude_attention(event: ClaudeAttentionEvent, raw: &str) -> Option<ClaudeAttention> {
    let payload = parse_payload(raw);
    match event {
        ClaudeAttentionEvent::Notification => notification_attention(&payload),
        ClaudeAttentionEvent::PreToolUse => question_attention(&payload),
        ClaudeAttentionEvent::PostToolUse => {
            is_claude_question_tool(&field_text(&payload, "tool_name"))
                .then(|| ClaudeAttention::of(KeptAttentionState::Working, ""))
        }
        ClaudeAttentionEvent::PermissionDenied => Some(denied_attention(&payload)),
        ClaudeAttentionEvent::Stop => Some(ClaudeAttention {
            closing: closing_from_stop(raw),
            ..ClaudeAttention::of(KeptAttentionState::Done, "")
        }),
        ClaudeAttentionEvent::StopFailure => Some(ClaudeAttention::of(
            KeptAttentionState::Error,
            or_default(field_text(&payload, "error"), "Turn failed"),
        )),
    }
}
