use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::clock::Clock;
use ostia_base::js::{js_trim, static_regex, utf16_len};
use ostia_base::path_guard::expand_home;
use ostia_contract::agent_launch::resume_flags;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use ostia_contract::shell_quote::quote_arg;
use ostia_diagnostics::renderer_reports::ReportLimiter;
use regex::Regex;
use serde_json::Value;

pub const AGENT_TASKS_PER_MINUTE: usize = 6;
const AGENT_TASK_WINDOW_MS: i64 = 60_000;
pub const REACHED_PANES_MAX: usize = 256;

const AGENT_OFFER_TEXT_MAX: usize = 2000;
const AGENT_OFFER_LABEL_MAX: usize = 120;
const AGENT_PROMPT_MAX: usize = 16_000;
const WORKSPACE_ID_MAX: usize = 200;

static MANAGER_AGENT_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));

fn has_control_character(text: &str, allowed: &str) -> bool {
    text.chars()
        .any(|ch| (ch < ' ' || ch == '\x7f') && !allowed.contains(ch))
}

fn one_line(raw: &Value, max: usize) -> Option<String> {
    let text = raw.as_str()?;
    if has_control_character(text, "") {
        return None;
    }
    let text = js_trim(text);
    (!text.is_empty() && utf16_len(text) <= max).then(|| text.to_owned())
}

pub fn offer_text(raw: &Value) -> Option<String> {
    one_line(raw, AGENT_OFFER_TEXT_MAX)
}

pub fn offer_label(raw: &Value) -> Option<String> {
    one_line(raw, AGENT_OFFER_LABEL_MAX)
}

pub fn agent_prompt(raw: &Value) -> Option<String> {
    let text = raw.as_str()?;
    if has_control_character(text, "\n\t") {
        return None;
    }
    let prompt = js_trim(text);
    (!prompt.is_empty() && utf16_len(prompt) <= AGENT_PROMPT_MAX).then(|| prompt.to_owned())
}

pub fn agent_name(raw: &Value) -> Option<String> {
    let name = raw.as_str()?;
    MANAGER_AGENT_NAME.is_match(name).then(|| name.to_owned())
}

pub fn workspace_id_of(raw: &Value) -> Option<String> {
    let id = raw.as_str()?;
    (!id.is_empty() && utf16_len(id) <= WORKSPACE_ID_MAX).then(|| id.to_owned())
}

pub fn agent_task_limiter(now: Clock) -> ReportLimiter {
    ReportLimiter::new(AGENT_TASKS_PER_MINUTE, AGENT_TASK_WINDOW_MS, now)
}

pub fn workspace_folder(work_dir: Option<&str>, home: &Path) -> Option<PathBuf> {
    let work_dir = work_dir.filter(|dir| !dir.is_empty())?;
    let expanded = expand_home(work_dir, home);
    expanded.is_absolute().then_some(expanded)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldResume {
    pub resume: AgentResume,
    pub held: bool,
}

fn can_fork(agent: ResumableAgent) -> bool {
    agent != ResumableAgent::Agy
}

fn agent_command_line(resume: &AgentResume, words: &[&str]) -> String {
    let mut parts = vec![format!("'{}'", resume.agent.name())];
    parts.extend(words.iter().map(|word| (*word).to_owned()));
    parts.extend(
        resume_flags(resume.agent, &resume.args)
            .iter()
            .map(|arg| quote_arg(arg)),
    );
    parts.join(" ")
}

fn resume_command(resume: &AgentResume) -> String {
    let id = resume.id.as_str();
    match resume.agent {
        ResumableAgent::Claude => agent_command_line(resume, &["--resume", id]),
        ResumableAgent::Codex => agent_command_line(resume, &["resume", id]),
        ResumableAgent::Agy => agent_command_line(resume, &["--conversation", id]),
    }
}

fn fork_command(resume: &AgentResume) -> String {
    let id = resume.id.as_str();
    match resume.agent {
        ResumableAgent::Claude => agent_command_line(resume, &["--resume", id, "--fork-session"]),
        _ => agent_command_line(resume, &["fork", id]),
    }
}

pub fn continue_command(found: &HeldResume, prompt: &str) -> String {
    let base = if found.held && can_fork(found.resume.agent) {
        fork_command(&found.resume)
    } else {
        resume_command(&found.resume)
    };
    format!("{base} {}", quote_arg(prompt))
}
