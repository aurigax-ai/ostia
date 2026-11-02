use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnStepKind {
    Edit,
    Command,
    Search,
    Read,
    Subagent,
    Web,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    Pending,
    Active,
    Done,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanItem {
    pub text: String,
    pub status: PlanStatus,
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

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

pub fn last_turns(events: &[StreamEvent], turns: usize) -> Vec<StreamEvent> {
    let starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event, StreamEvent::TurnStarted { .. }))
        .map(|(index, _)| index)
        .collect();
    let first = if turns > 0 && starts.len() > turns {
        starts[starts.len() - turns]
    } else {
        0
    };
    events[first..].to_vec()
}
