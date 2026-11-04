use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::agent_launch::{TypedLaunch, resume_flags, typed_launch_of};
use crate::hidden_text::has_control_character;
use crate::shell_quote::quote_arg;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typed: Option<TypedLaunch>,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{} cannot fork", .0.name())]
pub struct CannotFork(pub ResumableAgent);

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
        typed: None,
    })
}

pub fn parse_stored_resume(raw: &Value) -> Option<AgentResume> {
    let mut resume = parse_agent_resume(raw)?;
    resume.typed = raw
        .get("typed")
        .and_then(|typed| typed_launch_of(resume.agent, typed));
    Some(resume)
}

pub fn can_fork(agent: ResumableAgent) -> bool {
    agent != ResumableAgent::Agy
}

fn agent_command_line(resume: &AgentResume, words: &[&str]) -> String {
    let typed = resume
        .typed
        .as_ref()
        .and_then(|typed| serde_json::to_value(typed).ok())
        .and_then(|raw| typed_launch_of(resume.agent, &raw));
    let mut parts: Vec<String> = typed
        .iter()
        .flat_map(|typed| typed.env.iter())
        .map(|(name, value)| format!("{name}={}", quote_arg(value)))
        .collect();
    parts.push(format!("'{}'", resume.agent.name()));
    parts.extend(words.iter().map(|word| (*word).to_owned()));
    parts.extend(
        resume_flags(resume.agent, &resume.args)
            .iter()
            .map(|arg| quote_arg(arg)),
    );
    parts.extend(
        typed
            .iter()
            .flat_map(|typed| typed.args.iter())
            .map(|arg| quote_arg(arg)),
    );
    parts.join(" ")
}

pub fn resume_command(resume: &AgentResume) -> String {
    let id = resume.id.as_str();
    match resume.agent {
        ResumableAgent::Claude => agent_command_line(resume, &["--resume", id]),
        ResumableAgent::Codex => agent_command_line(resume, &["resume", id]),
        ResumableAgent::Agy => agent_command_line(resume, &["--conversation", id]),
    }
}

pub fn fork_command(resume: &AgentResume) -> Result<String, CannotFork> {
    let id = resume.id.as_str();
    match resume.agent {
        ResumableAgent::Claude => Ok(agent_command_line(
            resume,
            &["--resume", id, "--fork-session"],
        )),
        ResumableAgent::Codex => Ok(agent_command_line(resume, &["fork", id])),
        ResumableAgent::Agy => Err(CannotFork(resume.agent)),
    }
}
