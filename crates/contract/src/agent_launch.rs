use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::{Serialize, Serializer};
use serde_json::Value;

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
const MAX_ENV: usize = 32;
const MAX_ENV_VALUE: usize = 1024;

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

fn typed_claude_flag(name: &str) -> Option<Arity> {
    Some(match name {
        "--allow-dangerously-skip-permissions" | "--chrome" | "--dangerously-skip-permissions" => {
            Arity::None
        }
        "--agent"
        | "--agents"
        | "--append-system-prompt-file"
        | "--debug-file"
        | "--plugin-dir"
        | "--plugin-url"
        | "--setting-sources"
        | "--settings"
        | "--system-prompt-file" => Arity::One,
        "--add-dir" | "--allowed-tools" | "--allowedTools" | "--mcp-config" => Arity::Many,
        _ => return claude_flag(name),
    })
}

fn typed_codex_flag(name: &str) -> Option<Arity> {
    Some(match name {
        "--approve-for-me"
        | "--dangerously-bypass-approvals-and-sandbox"
        | "--dangerously-bypass-hook-trust"
        | "--yolo" => Arity::None,
        "--add-dir"
        | "--disable"
        | "--enable"
        | "-p"
        | "--profile"
        | "--remote"
        | "--remote-auth-token-env" => Arity::One,
        _ => return codex_flag(name),
    })
}

fn typed_agent_flag(agent: ResumableAgent, name: &str) -> Option<Arity> {
    match agent {
        ResumableAgent::Claude => typed_claude_flag(name),
        ResumableAgent::Codex => typed_codex_flag(name),
        ResumableAgent::Agy => agy_flag(name),
    }
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

type FlagTable = fn(ResumableAgent, &str) -> Option<Arity>;

fn split_flag(agent: ResumableAgent, flags: FlagTable, arg: &str) -> (String, Option<String>) {
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
    if length > 2 && flags(agent, name).is_some() {
        let rest = &arg[short_end..];
        return (
            name.to_owned(),
            Some(rest.strip_prefix('=').unwrap_or(rest).to_owned()),
        );
    }
    (if length == 2 { name } else { arg }.to_owned(), None)
}

fn is_carried(agent: ResumableAgent, name: &str, values: &[String]) -> bool {
    agent_flag(agent, name).is_some()
        && values.iter().all(|value| value_allowed(agent, name, value))
}

fn read_flags(
    agent: ResumableAgent,
    flags: FlagTable,
    argv: &[String],
    keep: impl Fn(&str, &[String]) -> bool,
    spaced_lists: bool,
) -> Vec<String> {
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
        let (name, inline) = split_flag(agent, flags, arg);
        let Some(arity) = flags(agent, &name) else {
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
            Arity::Many => {
                if let Some(value) = inline {
                    values.push(value);
                } else if spaced_lists && next < argv.len() && !argv[next].starts_with('-') {
                    values.push(argv[next].clone());
                    next += 1;
                } else {
                    continue;
                }
            }
        }
        if values
            .iter()
            .any(|value| value.starts_with('-') || !is_safe_value(value, MAX_ARG_LENGTH))
        {
            continue;
        }
        if !keep(&name, &values) {
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

pub fn resume_flags(agent: ResumableAgent, argv: &[String]) -> Vec<String> {
    read_flags(
        agent,
        agent_flag,
        argv,
        |name, values| is_carried(agent, name, values),
        false,
    )
}

static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"(?i-u)KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT|(^|[_.])(PIN|PW)($|[_.])",
    )
});

static CODE_LOADING_ENV: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"(?i-u)^(LD_|DYLD_|XDG_|GIT_|NPM_CONFIG_|CLAUDE_CODE_SHELL)|_BASE_URL$|^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|PATH|HOME|SHELL|PROMPT_COMMAND|ZDOTDIR|SHELLOPTS|BASHOPTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|PERLLIB|PERL5DB|RUBYOPT|RUBYLIB|LUA_PATH|LUA_CPATH|CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|SSH_ASKPASS|EDITOR|VISUAL|PAGER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$",
    )
});

static ENV_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"));

static ENV_KEY_SEGMENT: LazyLock<Regex> = LazyLock::new(|| static_regex(r"(?i-u)(^|\.)env(\.|$)"));

static ABSOLUTE_PATH: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^(/|[A-Za-z]:[\\/])"));

const APP_ENV_PREFIX: &str = "OSTIA_";

fn is_safe_config(agent: ResumableAgent, value: &str) -> bool {
    if agent == ResumableAgent::Claude {
        return !value
            .trim_start_matches(ostia_base::js::is_js_space)
            .starts_with('{');
    }
    let key = js_trim(value.split('=').next().unwrap_or(value));
    !ENV_KEY_SEGMENT.is_match(key) && !SECRET_NAME.is_match(key)
}

fn is_config_flag(agent: ResumableAgent, name: &str) -> bool {
    match agent {
        ResumableAgent::Claude => matches!(name, "--settings" | "--agents" | "--mcp-config"),
        ResumableAgent::Codex => matches!(name, "-c" | "--config"),
        ResumableAgent::Agy => false,
    }
}

fn typed_flags(agent: ResumableAgent, argv: &[String]) -> Vec<String> {
    read_flags(
        agent,
        typed_agent_flag,
        argv,
        |name, values| {
            !is_carried(agent, name, values)
                && (!is_config_flag(agent, name)
                    || values.iter().all(|value| is_safe_config(agent, value)))
        },
        true,
    )
}

fn safe_env(raw: Option<&Value>) -> Vec<(String, String)> {
    let Some(record) = raw.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in record {
        if out.len() >= MAX_ENV {
            break;
        }
        if !ENV_NAME.is_match(name) || CODE_LOADING_ENV.is_match(name) {
            continue;
        }
        if SECRET_NAME.is_match(name) && name != "CLAUDE_SKIP_SESSION_LOG" {
            continue;
        }
        if name.starts_with(APP_ENV_PREFIX) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        if !is_safe_value(value, MAX_ENV_VALUE) {
            continue;
        }
        if matches!(name.as_str(), "CLAUDE_CONFIG_DIR" | "CODEX_HOME")
            && !ABSOLUTE_PATH.is_match(value)
        {
            continue;
        }
        out.push((name.clone(), value.to_owned()));
    }
    out
}

fn serialize_env<S: Serializer>(
    env: &[(String, String)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(env.iter().map(|(name, value)| (name, value)))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TypedLaunch {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "serialize_env"
    )]
    pub env: Vec<(String, String)>,
}

pub fn typed_launch_of(agent: ResumableAgent, raw: &Value) -> Option<TypedLaunch> {
    let record = raw.as_object()?;
    let args = record
        .get("args")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .map(|arg| arg.as_str().map(str::to_owned))
                .collect::<Option<Vec<String>>>()
        })
        .map_or_else(Vec::new, |argv| typed_flags(agent, &argv));
    let env = safe_env(record.get("env"));
    (!args.is_empty() || !env.is_empty()).then_some(TypedLaunch { args, env })
}
