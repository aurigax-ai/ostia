use serde::Serialize;
use serde_json::{Map, Value};

use crate::hook_payload::parse_payload;
use crate::utf16_prefix::utf16_prefix;

pub const HIBERNATE_HELD: &str = "typed";

pub const AGENT_BUSY_REASONS: [AgentBusyReason; 5] = [
    AgentBusyReason::Subagent,
    AgentBusyReason::BackgroundTask,
    AgentBusyReason::ScheduledTask,
    AgentBusyReason::ChildProcess,
    AgentBusyReason::Unknown,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentBusyReason {
    Subagent,
    BackgroundTask,
    ScheduledTask,
    ChildProcess,
    Unknown,
}

impl AgentBusyReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subagent => "subagent",
            Self::BackgroundTask => "background-task",
            Self::ScheduledTask => "scheduled-task",
            Self::ChildProcess => "child-process",
            Self::Unknown => "unknown",
        }
    }
}

pub const CLAUDE_WORK_EVENTS: [ClaudeWorkEvent; 3] = [
    ClaudeWorkEvent::SubagentStart,
    ClaudeWorkEvent::SubagentStop,
    ClaudeWorkEvent::Stop,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeWorkEvent {
    SubagentStart,
    SubagentStop,
    Stop,
}

impl ClaudeWorkEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::Stop => "Stop",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_started: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_stopped: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub turn_ended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled: Option<usize>,
}

const UNNAMED_SUBAGENT: &str = "subagent";
const SUBAGENT_ID_MAX: usize = 200;
const COUNT_MAX: f64 = 10_000.0;
const ENDED_TASK_STATUSES: [&str; 6] = [
    "completed",
    "failed",
    "killed",
    "stopped",
    "cancelled",
    "canceled",
];

fn is_false(value: &bool) -> bool {
    !*value
}

pub fn is_agent_busy_reason(value: &Value) -> bool {
    value.as_str().is_some_and(|reason| {
        AGENT_BUSY_REASONS
            .iter()
            .any(|known| known.as_str() == reason)
    })
}

pub fn is_claude_work_event(value: &Value) -> bool {
    value.as_str().is_some_and(|name| {
        CLAUDE_WORK_EVENTS
            .iter()
            .any(|event| event.as_str() == name)
    })
}

fn subagent_name(id: &str) -> String {
    if id.is_empty() {
        UNNAMED_SUBAGENT.to_owned()
    } else {
        utf16_prefix(id, SUBAGENT_ID_MAX).to_owned()
    }
}

fn subagent_id(value: Option<&str>) -> String {
    value.map_or_else(|| UNNAMED_SUBAGENT.to_owned(), subagent_name)
}

fn tasks_in_flight(value: Option<&Value>, stopping: Option<&str>) -> Option<usize> {
    let tasks = value?.as_array()?;
    let in_flight = tasks
        .iter()
        .filter(|entry| {
            let task = entry.as_object();
            let id = task.and_then(|task| task.get("id")).and_then(Value::as_str);
            if stopping.is_some() && id == stopping {
                return false;
            }
            let status = task
                .and_then(|task| task.get("status"))
                .and_then(Value::as_str);
            !status.is_some_and(|status| ENDED_TASK_STATUSES.contains(&status))
        })
        .count();
    Some(in_flight)
}

fn registry_counts(
    payload: &Map<String, Value>,
    stopping: Option<&str>,
) -> (Option<usize>, Option<usize>) {
    let tasks = tasks_in_flight(payload.get("background_tasks"), stopping);
    let scheduled = payload
        .get("session_crons")
        .and_then(Value::as_array)
        .map(Vec::len);
    (tasks, scheduled)
}

pub fn claude_work_report(event: ClaudeWorkEvent, raw: &str) -> AgentWorkReport {
    let payload = parse_payload(raw);
    match event {
        ClaudeWorkEvent::SubagentStart => AgentWorkReport {
            subagent_started: Some(subagent_id(payload.get("agent_id").and_then(Value::as_str))),
            ..AgentWorkReport::default()
        },
        ClaudeWorkEvent::SubagentStop => {
            let id = subagent_id(payload.get("agent_id").and_then(Value::as_str));
            let (tasks, scheduled) = registry_counts(&payload, Some(id.as_str()));
            AgentWorkReport {
                subagent_stopped: Some(id),
                tasks,
                scheduled,
                ..AgentWorkReport::default()
            }
        }
        ClaudeWorkEvent::Stop => {
            let (tasks, scheduled) = registry_counts(&payload, None);
            AgentWorkReport {
                turn_ended: true,
                tasks,
                scheduled,
                ..AgentWorkReport::default()
            }
        }
    }
}

fn count(value: Option<&Value>) -> Option<usize> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number >= 0.0).then(|| number.min(COUNT_MAX) as usize)
}

pub fn normalize_work_report(raw: &Value) -> AgentWorkReport {
    let Some(src) = raw.as_object() else {
        return AgentWorkReport::default();
    };
    AgentWorkReport {
        subagent_started: src
            .get("subagentStarted")
            .and_then(Value::as_str)
            .map(subagent_name),
        subagent_stopped: src
            .get("subagentStopped")
            .and_then(Value::as_str)
            .map(subagent_name),
        turn_ended: matches!(src.get("turnEnded"), Some(Value::Bool(true))),
        tasks: count(src.get("tasks")),
        scheduled: count(src.get("scheduled")),
    }
}
