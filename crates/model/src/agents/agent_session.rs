use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use regex::Regex;

use crate::attention::{AttentionState, PaneAttention};
use crate::layout::types::{PaneNode, SurfaceKind};
use crate::terminal::blocks_store::CommandBlock;

#[derive(Clone, Debug, PartialEq)]
pub struct AgentSession {
    pub agent: ResumableAgent,
    pub title: Option<String>,
    pub resume: Option<AgentResume>,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub state: AttentionState,
    pub message: Option<String>,
}

static TITLE_DECORATION: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[^\p{L}\p{N}]+"));
const SHELL_TITLES: [&str; 4] = ["zsh", "bash", "sh", "fish"];

pub fn session_title(title: &str, agent: ResumableAgent) -> Option<String> {
    let stripped = TITLE_DECORATION.replace(title, "");
    let clean = js_trim(&stripped);
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_lowercase();
    let name = agent.name();
    if lower == name
        || lower.starts_with(&format!("{name} "))
        || SHELL_TITLES.contains(&lower.as_str())
    {
        return None;
    }
    Some(clean.to_owned())
}

pub fn agent_session(
    pane: &PaneNode,
    running: Option<&CommandBlock>,
    attention: Option<&PaneAttention>,
    agent: Option<ResumableAgent>,
) -> Option<AgentSession> {
    if pane.kind != SurfaceKind::Terminal {
        return None;
    }
    let running = running?;
    let agent = agent?;
    Some(AgentSession {
        agent,
        title: if pane.default_title {
            None
        } else {
            session_title(&pane.title, agent)
        },
        resume: pane
            .resume
            .as_ref()
            .filter(|stored| stored.agent == agent)
            .cloned(),
        command: running.command.clone(),
        cwd: running.cwd.clone(),
        started_at: running.started_at,
        state: attention.map_or(AttentionState::None, |a| a.state),
        message: attention.and_then(|a| a.message.clone()),
    })
}
