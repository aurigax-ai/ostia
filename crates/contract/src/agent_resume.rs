use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::agent_launch::resume_flags;
use crate::hidden_text::has_control_character;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumableAgent {
    Claude,
    Codex,
    Agy,
}

impl ResumableAgent {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "agy" => Some(Self::Agy),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Agy => "agy",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentResume {
    pub agent: ResumableAgent,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

const RESUME_CWD_MAX: usize = 4096;

static RESUME_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"));

pub fn is_resume_id(id: &str) -> bool {
    RESUME_ID.is_match(id)
}

fn is_resume_cwd(value: &str) -> bool {
    value.starts_with('/') && utf16_len(value) <= RESUME_CWD_MAX && !has_control_character(value)
}

fn resume_args(agent: ResumableAgent, raw: Option<&Value>) -> Vec<String> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let strings: Option<Vec<String>> = items
        .iter()
        .map(|arg| arg.as_str().map(str::to_owned))
        .collect();
    strings.map_or_else(Vec::new, |argv| resume_flags(agent, &argv))
}

pub fn parse_agent_resume(raw: &Value) -> Option<AgentResume> {
    let record = raw.as_object()?;
    let agent = ResumableAgent::parse(record.get("agent")?.as_str()?)?;
    let id = record.get("id")?.as_str()?;
    if !is_resume_id(id) {
        return None;
    }
    Some(AgentResume {
        agent,
        id: id.to_owned(),
        cwd: record
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| is_resume_cwd(cwd))
            .map(str::to_owned),
        args: resume_args(agent, record.get("args")),
    })
}
