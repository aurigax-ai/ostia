use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_contract::argv::split_args;
use regex::{Captures, Regex};

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{(title|body|pane)\}"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotifyCommandValues {
    pub title: String,
    pub body: String,
    pub pane: String,
}

pub fn expand_notify_command(template: &str, values: &NotifyCommandValues) -> Option<Vec<String>> {
    let tokens = split_args(template)?;
    if tokens.is_empty() {
        return None;
    }
    let replace = |caps: &Captures| match &caps[1] {
        "title" => values.title.as_str(),
        "body" => values.body.as_str(),
        _ => values.pane.as_str(),
    };
    Some(
        tokens
            .iter()
            .map(|token| PLACEHOLDER.replace_all(token, replace).into_owned())
            .collect(),
    )
}

pub fn run_notify_command(template: &str, values: &NotifyCommandValues) -> bool {
    let Some(argv) = expand_notify_command(template, values) else {
        return false;
    };
    if argv.iter().any(|arg| arg.contains('\0')) {
        return false;
    }
    let spawned = Command::new(&argv[0])
        .args(&argv[1..])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = spawned {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    true
}
