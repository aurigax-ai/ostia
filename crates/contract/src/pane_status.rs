use ostia_base::js::js_number_text;
use serde_json::Value;

use crate::utf16_prefix::utf16_prefix;

#[derive(Clone, Copy)]
pub enum PaneState {
    Working,
    Waiting,
    Done,
    Error,
    Idle,
    Hibernated,
    Waking,
    Exited,
    Shell,
}

impl PaneState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Error => "error",
            Self::Idle => "idle",
            Self::Hibernated => "hibernated",
            Self::Waking => "waking",
            Self::Exited => "exited",
            Self::Shell => "shell",
        }
    }
}

pub const SHORT_ID_LENGTH: usize = 8;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;

pub struct PaneGit {
    pub branch: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub changed: i64,
}

pub struct PaneProcess {
    pub id: String,
    pub status: String,
}

pub struct PaneMail {
    pub queued: i64,
    pub failed: i64,
    pub sent_queued: i64,
    pub sent_failed: i64,
}

pub struct PaneStatusChanges {
    pub first: bool,
    pub states: Vec<String>,
    pub commands: i64,
    pub failed: i64,
    pub closing: bool,
    pub mail: i64,
}

pub struct PaneStatus {
    pub pane: String,
    pub title: String,
    pub state: PaneState,
    pub since_ms: Option<f64>,
    pub closing: Option<String>,
    pub keep_awake: bool,
    pub exit_code: Option<i64>,
    pub process: Option<PaneProcess>,
    pub git: Option<PaneGit>,
    pub mail: PaneMail,
    pub stale: Vec<String>,
    pub conflict: Vec<String>,
    pub changes: PaneStatusChanges,
}

pub fn short_id(id: &str) -> &str {
    utf16_prefix(id, SHORT_ID_LENGTH)
}

pub fn age_label(ms: f64) -> String {
    if ms < MINUTE {
        return format!("{}s", js_number_text((ms / 1000.0).floor().max(0.0)));
    }
    if ms < HOUR {
        return format!("{}m", js_number_text((ms / MINUTE).floor()));
    }
    if ms < DAY {
        return format!("{}h", js_number_text((ms / HOUR).floor()));
    }
    format!("{}d", js_number_text((ms / DAY).floor()))
}

fn when(on: bool, text: String) -> String {
    if on { text } else { String::new() }
}

fn present(parts: Vec<String>) -> Vec<String> {
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

fn git_part(git: &PaneGit) -> String {
    present(vec![
        git.branch.as_deref().unwrap_or("detached").to_owned(),
        when(git.changed > 0, format!("+{}", git.changed)),
        when(git.ahead > 0, format!("↑{}", git.ahead)),
        when(git.behind > 0, format!("↓{}", git.behind)),
    ])
    .join(" ")
}

fn changes_part(changes: &PaneStatusChanges) -> String {
    if changes.first {
        return "first look".to_owned();
    }
    let parts = present(vec![
        when(changes.states.len() > 1, changes.states.join("→")),
        when(
            changes.commands > 0,
            format!("{} commands, {} failed", changes.commands, changes.failed),
        ),
        when(changes.closing, "new closing line".to_owned()),
        when(changes.mail > 0, format!("{} mail delivered", changes.mail)),
    ]);
    if parts.is_empty() {
        "no change since last".to_owned()
    } else {
        format!("since last: {}", parts.join(", "))
    }
}

fn json_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

pub fn status_line(status: &PaneStatus) -> String {
    let state_text = match status.since_ms {
        None => status.state.as_str().to_owned(),
        Some(ms) => format!("{} {}", status.state.as_str(), age_label(ms)),
    };
    let mail_text = present(vec![
        format!("mail {}", status.mail.queued),
        when(
            status.mail.failed > 0,
            format!("failed {}", status.mail.failed),
        ),
    ])
    .join(" ");
    let parts = present(vec![
        short_id(&status.pane).to_owned(),
        status.title.clone(),
        state_text,
        status
            .exit_code
            .map_or_else(String::new, |code| format!("exit {code}")),
        when(status.keep_awake, "keep-awake".to_owned()),
        status.process.as_ref().map_or_else(String::new, |process| {
            format!("process {} {}", process.id, process.status)
        }),
        status.git.as_ref().map_or_else(String::new, git_part),
        mail_text,
        status
            .closing
            .as_deref()
            .filter(|closing| !closing.is_empty())
            .map_or_else(String::new, json_string),
        when(
            !status.stale.is_empty(),
            format!("stale: {}", status.stale.join(", ")),
        ),
        when(
            !status.conflict.is_empty(),
            format!("conflict: {}", status.conflict.join(", ")),
        ),
    ]);
    format!("{}  ({})", parts.join("  "), changes_part(&status.changes))
}
