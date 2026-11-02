use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use ostia_base::js_json::parse_js_json;
use regex::Regex;
use serde_json::Value;

pub use crate::agent_plugins::HookAgent;

pub const AGENT_HOOK_INPUT_MAX: usize = 1024 * 1024;

static ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentStop {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub message: Option<String>,
    pub background_work: bool,
}

fn id_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| ID_PATTERN.is_match(id))
        .map(str::to_owned)
}

fn non_empty_list(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

pub fn parse_agent_stop(_agent: HookAgent, input: &str) -> Option<AgentStop> {
    if input.len() > AGENT_HOOK_INPUT_MAX {
        return None;
    }
    let Value::Object(payload) = parse_js_json(input).ok()? else {
        return None;
    };
    let session_id = id_of(payload.get("session_id"))?;
    let message = payload
        .get("last_assistant_message")
        .and_then(Value::as_str)
        .filter(|message| !js_trim(message).is_empty())
        .map(str::to_owned);
    Some(AgentStop {
        session_id,
        turn_id: id_of(payload.get("turn_id")).or_else(|| id_of(payload.get("prompt_id"))),
        message,
        background_work: non_empty_list(payload.get("background_tasks"))
            || non_empty_list(payload.get("session_crons")),
    })
}
