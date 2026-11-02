use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Number;

use crate::turn_hook::TurnStepKind;

pub const STREAM_TURNS_MAX: usize = 50;
pub const STREAM_TURNS_DEFAULT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    Pending,
    Active,
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanItem {
    pub text: String,
    pub status: PlanStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditChange {
    Add,
    Update,
    Delete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnEnd {
    Done,
    Interrupted,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamEnd {
    PaneClosed,
    AgentClosed,
    Unavailable,
    OutOfScope,
    TooSlow,
    TooLarge,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    #[serde(rename = "turn.started")]
    TurnStarted { turn: String },
    #[serde(rename = "turn.ended")]
    TurnEnded { turn: String, status: TurnEnd },
    #[serde(rename = "prompt")]
    Prompt {
        turn: String,
        id: String,
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "text")]
    Text {
        turn: String,
        id: String,
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "tool")]
    Tool {
        turn: String,
        id: String,
        kind: TurnStepKind,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "tool.result")]
    ToolResult {
        turn: String,
        id: String,
        output: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<Number>,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "edit")]
    Edit {
        turn: String,
        id: String,
        path: String,
        change: EditChange,
        diff: String,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "plan")]
    Plan {
        turn: String,
        id: String,
        items: Vec<PlanItem>,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
    },
    #[serde(rename = "session")]
    Session { session: String },
    #[serde(rename = "ask")]
    Ask { ask_id: String, kind: String },
    #[serde(rename = "ask.resolved")]
    AskResolved { ask_id: String, outcome: String },
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "ended")]
    Ended { reason: StreamEnd },
}

impl fmt::Debug for StreamEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TurnStarted { turn } => {
                f.debug_struct("TurnStarted").field("turn", turn).finish()
            }
            Self::TurnEnded { turn, status } => f
                .debug_struct("TurnEnded")
                .field("turn", turn)
                .field("status", status)
                .finish(),
            Self::Prompt {
                turn, id, append, ..
            } => f
                .debug_struct("Prompt")
                .field("turn", turn)
                .field("id", id)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::Text {
                turn, id, append, ..
            } => f
                .debug_struct("Text")
                .field("turn", turn)
                .field("id", id)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::Tool {
                turn,
                id,
                kind,
                append,
                ..
            } => f
                .debug_struct("Tool")
                .field("turn", turn)
                .field("id", id)
                .field("kind", kind)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::ToolResult {
                turn,
                id,
                exit_code,
                is_error,
                append,
                ..
            } => f
                .debug_struct("ToolResult")
                .field("turn", turn)
                .field("id", id)
                .field("exit_code", exit_code)
                .field("is_error", is_error)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::Edit {
                turn,
                id,
                change,
                append,
                ..
            } => f
                .debug_struct("Edit")
                .field("turn", turn)
                .field("id", id)
                .field("change", change)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::Plan {
                turn, id, append, ..
            } => f
                .debug_struct("Plan")
                .field("turn", turn)
                .field("id", id)
                .field("append", append)
                .finish_non_exhaustive(),
            Self::Session { session } => {
                f.debug_struct("Session").field("session", session).finish()
            }
            Self::Ask { ask_id, kind } => f
                .debug_struct("Ask")
                .field("ask_id", ask_id)
                .field("kind", kind)
                .finish(),
            Self::AskResolved { ask_id, outcome } => f
                .debug_struct("AskResolved")
                .field("ask_id", ask_id)
                .field("outcome", outcome)
                .finish(),
            Self::Live => f.write_str("Live"),
            Self::Ended { reason } => f.debug_struct("Ended").field("reason", reason).finish(),
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_turn_start(event: &StreamEvent) -> bool {
    matches!(event, StreamEvent::TurnStarted { .. })
}

pub fn turns_started(events: &[StreamEvent]) -> usize {
    events.iter().filter(|event| is_turn_start(event)).count()
}

pub fn last_turns(events: &[StreamEvent], turns: usize) -> Vec<StreamEvent> {
    let starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| is_turn_start(event))
        .map(|(index, _)| index)
        .collect();
    let first = if starts.len() > turns {
        starts.get(starts.len() - turns).copied().unwrap_or(0)
    } else {
        0
    };
    events[first..].to_vec()
}
