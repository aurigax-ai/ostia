use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, static_regex, utf16_len};
use regex::Regex;

use crate::agent_resume::ResumableAgent;
use crate::hidden_text::has_control_character;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Arity {
    None,
    One,
    Optional,
    Many,
}

const MAX_ARGS: usize = 64;
const MAX_ARG_LENGTH: usize = 2048;
const MAX_ARGS_LENGTH: usize = 8192;

fn claude_flag(name: &str) -> Option<Arity> {
    Some(match name {
        "--ax-screen-reader"
        | "--bare"
        | "--brief"
        | "--disable-slash-commands"
        | "--exclude-dynamic-system-prompt-sections"
        | "--ide"
        | "--no-chrome"
        | "--restricted"
        | "--safe-mode"
        | "--strict-mcp-config"
        | "--verbose" => Arity::None,
        "--append-system-prompt"
        | "--autocompact"
        | "--effort"
        | "--fallback-model"
        | "--model"
        | "--name"
        | "--permission-mode"
        | "--remote-control-session-name-prefix"
        | "--system-prompt"
        | "--system-prompt-snapshot" => Arity::One,
        "--debug" | "--remote-control" => Arity::Optional,
        "--betas" | "--disallowed-tools" | "--disallowedTools" | "--tools" => Arity::Many,
        _ => return None,
    })
}

fn codex_flag(name: &str) -> Option<Arity> {
    Some(match name {
        "--no-alt-screen" | "--oss" | "--search" | "--strict-config" => Arity::None,
        "-a" | "--ask-for-approval" | "-c" | "--config" | "--local-provider" | "-m" | "--model"
        | "-s" | "--sandbox" => Arity::One,
        _ => return None,
    })
}

fn agy_flag(name: &str) -> Option<Arity> {
    matches!(name, "--effort" | "--model").then_some(Arity::One)
}

fn agent_flag(agent: ResumableAgent, name: &str) -> Option<Arity> {
    match agent {
        ResumableAgent::Claude => claude_flag(name),
        ResumableAgent::Codex => codex_flag(name),
        ResumableAgent::Agy => agy_flag(name),
    }
}

fn alias(agent: ResumableAgent, short: &str) -> Option<&'static str> {
    match (agent, short) {
        (ResumableAgent::Claude, "-d") => Some("--debug"),
        (ResumableAgent::Claude, "-n") => Some("--name"),
        _ => None,
    }
}

fn is_model_config(value: &str) -> bool {
    value.find('=').is_some_and(|eq| {
        eq > 0
            && matches!(
                ostia_base::js::js_trim(&value[..eq]),
                "model"
                    | "model_reasoning_effort"
                    | "model_reasoning_summary"
                    | "model_verbosity"
                    | "service_tier"
            )
    })
}

fn value_allowed(agent: ResumableAgent, name: &str, value: &str) -> bool {
    match (agent, name) {
        (ResumableAgent::Claude, "--permission-mode") => {
            matches!(value, "dontAsk" | "manual" | "plan")
        }
        (ResumableAgent::Codex, "-a" | "--ask-for-approval") => {
            matches!(value, "untrusted" | "on-failure" | "on-request")
        }
        (ResumableAgent::Codex, "-c" | "--config") => is_model_config(value),
        (ResumableAgent::Codex, "-s" | "--sandbox") => {
            matches!(value, "read-only" | "workspace-write")
        }
        _ => true,
    }
}

static SECRET_TEXT: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let url_login =
        format!(r"[A-Za-z][A-Za-z0-9+.-]*://[^/{JS_SPACE_CLASS}:@]+:[^/{JS_SPACE_CLASS}@]+@");
    [
        r"sk-[A-Za-z0-9_-]{16,}",
        r"gh[opsur]_[A-Za-z0-9]{20,}",
        r"github_pat_",
        r"glpat-",
        r"xox[abposr]-",
        r"AKIA[0-9A-Z]{16}",
        r"AIza[0-9A-Za-z_-]{30,}",
        r"eyJ[A-Za-z0-9_-]{10,}\.",
        r"-----BEGIN ",
        url_login.as_str(),
        r"(?i)api[_-]?key|token|secret|passw|credential|authorization|bearer",
        r"[A-Za-z0-9_+=-]{40,}",
    ]
    .into_iter()
    .map(static_regex)
    .collect()
});

pub fn looks_secret(text: &str) -> bool {
    SECRET_TEXT.iter().any(|pattern| pattern.is_match(text))
}

fn is_safe_value(value: &str, max: usize) -> bool {
    utf16_len(value) <= max && !has_control_character(value) && !looks_secret(value)
}

fn split_flag(agent: ResumableAgent, arg: &str) -> (String, Option<String>) {
    if arg.starts_with("--") {
        return match arg.find('=') {
            Some(eq) if eq > 0 => (arg[..eq].to_owned(), Some(arg[eq + 1..].to_owned())),
            _ => (arg.to_owned(), None),
        };
    }
    let short_end = arg.char_indices().nth(2).map_or(arg.len(), |(at, _)| at);
    let short = &arg[..short_end];
    let name = alias(agent, short).unwrap_or(short);
    let length = utf16_len(arg);
    if length > 2 && agent_flag(agent, name).is_some() {
        let rest = &arg[short_end..];
        return (
            name.to_owned(),
            Some(rest.strip_prefix('=').unwrap_or(rest).to_owned()),
        );
    }
    (if length == 2 { name } else { arg }.to_owned(), None)
}

fn is_carried(agent: ResumableAgent, name: &str, values: &[String]) -> bool {
    values.iter().all(|value| value_allowed(agent, name, value))
}

pub fn resume_flags(agent: ResumableAgent, argv: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut total = 0;
    let mut next = 0;
    while next < argv.len() {
        let arg = &argv[next];
        next += 1;
        if arg == "--" {
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            continue;
        }
        let (name, inline) = split_flag(agent, arg);
        let Some(arity) = agent_flag(agent, &name) else {
            continue;
        };
        let mut values: Vec<String> = Vec::new();
        match arity {
            Arity::None => {
                if inline.is_some() {
                    continue;
                }
            }
            Arity::One => {
                if let Some(value) = inline {
                    values.push(value);
                } else if next < argv.len() {
                    values.push(argv[next].clone());
                    next += 1;
                } else {
                    continue;
                }
            }
            Arity::Optional => {
                if let Some(value) = inline {
                    values.push(value);
                } else if next < argv.len() && !argv[next].starts_with('-') {
                    continue;
                }
            }
            Arity::Many => match inline {
                Some(value) => values.push(value),
                None => continue,
            },
        }
        if values
            .iter()
            .any(|value| value.starts_with('-') || !is_safe_value(value, MAX_ARG_LENGTH))
        {
            continue;
        }
        if !is_carried(agent, &name, &values) {
            continue;
        }
        let group: Vec<String> = if arity == Arity::One {
            std::iter::once(name).chain(values).collect()
        } else {
            match values.first() {
                Some(value) => vec![format!("{name}={value}")],
                None => vec![name],
            }
        };
        let size: usize = group.iter().map(|part| utf16_len(part)).sum();
        if out.len() + group.len() > MAX_ARGS || total + size > MAX_ARGS_LENGTH {
            break;
        }
        out.extend(group);
        total += size;
    }
    out
}
