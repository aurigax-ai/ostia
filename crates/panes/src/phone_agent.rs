use ostia_base::js::{is_js_space, js_trim, utf16_len};
use ostia_contract::hidden_text::is_control;

use crate::hidden_text::is_hidden_format;

const COMMAND_MAX: usize = 8 * 1024;

const SUBCOMMANDS: &[&str] = &[
    "a",
    "agents",
    "app-server",
    "apply",
    "archive",
    "attach",
    "auth",
    "auto-mode",
    "cloud",
    "completion",
    "debug",
    "delete",
    "doctor",
    "e",
    "exec",
    "exec-server",
    "features",
    "fork",
    "gateway",
    "help",
    "import",
    "install",
    "kill",
    "login",
    "logout",
    "logs",
    "mcp",
    "migrate-rollouts",
    "plugin",
    "plugins",
    "purge",
    "queue",
    "remote-control",
    "respawn",
    "resume",
    "review",
    "rm",
    "sandbox",
    "setup-token",
    "stop",
    "ultrareview",
    "unarchive",
    "update",
    "upgrade",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhoneAgent {
    Claude,
    Codex,
}

impl PhoneAgent {
    fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

pub fn phone_agent_command(agent: PhoneAgent, raw: &str) -> Option<String> {
    let prompt = plain_block(raw);
    let words: Vec<&str> = prompt
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect();
    let first = words.first().copied().unwrap_or_default().to_lowercase();
    if words.len() < 2 || leads_with_flag(&prompt) || SUBCOMMANDS.contains(&first.as_str()) {
        return None;
    }
    let command = quote_argv(&[agent.command(), prompt.as_str()]);
    (utf16_len(&command) <= COMMAND_MAX).then_some(command)
}

fn plain_block(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    js_trim(&without_controls(&normalized)).to_owned()
}

fn without_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = u32::from(ch);
        if is_hidden_format(code) {
            out.push_str(&format!("\\u{code:04x}"));
        } else if !is_control(code) || ch == '\n' || ch == '\t' {
            out.push(ch);
        }
    }
    out
}

fn leads_with_flag(text: &str) -> bool {
    text.starts_with(['-', '+'])
}

fn quote_arg(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "@%+:,./_-".contains(ch))
    {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn quote_argv(argv: &[&str]) -> String {
    argv.iter()
        .copied()
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}
