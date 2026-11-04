use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use indexmap::IndexMap;
use ostia_base::js::js_trim;
use ostia_contract::argv::split_args;
use ostia_contract::chat_tools::{
    MCP_ENV_KEY, MCP_ENV_MAX, MCP_SECRETS_MAX, MCP_SERVER_NAME, McpServerSettings,
    McpTransportKind, SkillSummary, is_mcp_argv, is_mcp_secret_key, is_mcp_url, mcp_transport_of,
};
use ostia_contract::proto_guard::is_dangerous_segment;
use ostia_contract::shell_quote::quote_argv;

const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

static ROW_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyValueRow {
    pub id: u64,
    pub key: String,
    pub value: String,
}

pub fn new_row() -> KeyValueRow {
    KeyValueRow {
        id: ROW_SEQ.fetch_add(1, Ordering::Relaxed) + 1,
        key: String::new(),
        value: String::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretDraft {
    pub id: u64,
    pub key: String,
    pub value: String,
    pub saved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerDraft {
    pub name: String,
    pub transport: McpTransportKind,
    pub command: String,
    pub args: String,
    pub url: String,
    pub env: Vec<KeyValueRow>,
    pub secrets: Vec<SecretDraft>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpDraftField {
    Name,
    Command,
    Args,
    Url,
    Env,
    Secrets,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpDraftResult {
    Valid {
        server: McpServerSettings,
        secret_values: IndexMap<String, String>,
        removed_secrets: Vec<String>,
    },
    Invalid {
        errors: Vec<McpDraftField>,
    },
}

pub fn draft_from_server(server: Option<&McpServerSettings>) -> McpServerDraft {
    let argv: &[String] = server
        .and_then(|server| server.command.as_deref())
        .unwrap_or_default();
    McpServerDraft {
        name: server.map(|server| server.name.clone()).unwrap_or_default(),
        transport: server.map_or(McpTransportKind::Stdio, mcp_transport_of),
        command: argv.first().cloned().unwrap_or_default(),
        args: quote_argv(argv.get(1..).unwrap_or_default()),
        url: server
            .and_then(|server| server.url.clone())
            .unwrap_or_default(),
        env: server
            .map(|server| {
                server
                    .env
                    .iter()
                    .map(|(key, value)| KeyValueRow {
                        key: key.clone(),
                        value: value.clone(),
                        ..new_row()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        secrets: server
            .map(|server| {
                server
                    .secrets
                    .iter()
                    .map(|key| SecretDraft {
                        id: new_row().id,
                        key: key.clone(),
                        value: String::new(),
                        saved: true,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn is_blank(key: &str, value: &str) -> bool {
    js_trim(key).is_empty() && value.is_empty()
}

fn parse_env(rows: &[KeyValueRow]) -> Option<IndexMap<String, String>> {
    let mut env = IndexMap::new();
    for row in rows {
        if is_blank(&row.key, &row.value) {
            continue;
        }
        let key = js_trim(&row.key);
        if !MCP_ENV_KEY.is_match(key)
            || is_dangerous_segment(key)
            || OBJECT_PROTOTYPE_KEYS.contains(&key)
            || env.contains_key(key)
        {
            return None;
        }
        env.insert(key.to_owned(), row.value.clone());
    }
    (env.len() <= MCP_ENV_MAX).then_some(env)
}

fn secrets_valid(transport: McpTransportKind, rows: &[SecretDraft]) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    for row in rows {
        if is_blank(&row.key, &row.value) && !row.saved {
            continue;
        }
        let key = js_trim(&row.key);
        if !is_mcp_secret_key(transport, key) || seen.contains(key) {
            return false;
        }
        if !row.saved && row.value.is_empty() {
            return false;
        }
        seen.insert(key);
    }
    seen.len() <= MCP_SECRETS_MAX
}

enum Target {
    Command(Vec<String>),
    Url(String),
    None,
}

pub fn server_from_draft(
    draft: &McpServerDraft,
    original: Option<&McpServerSettings>,
    taken_names: &[String],
) -> McpDraftResult {
    let mut errors = Vec::new();
    let name = original.map_or_else(|| js_trim(&draft.name).to_owned(), |o| o.name.clone());
    if original.is_none() && (!MCP_SERVER_NAME.is_match(&name) || taken_names.contains(&name)) {
        errors.push(McpDraftField::Name);
    }
    let mut target = Target::None;
    let mut env = IndexMap::new();
    if draft.transport == McpTransportKind::Http {
        let url = js_trim(&draft.url);
        if is_mcp_url(url) {
            target = Target::Url(url.to_owned());
        } else {
            errors.push(McpDraftField::Url);
        }
    } else {
        let command = js_trim(&draft.command);
        let args = split_args(js_trim(&draft.args));
        if command.is_empty() {
            errors.push(McpDraftField::Command);
        }
        if args.is_none() {
            errors.push(McpDraftField::Args);
        }
        if let (false, Some(args)) = (command.is_empty(), args) {
            let mut argv = vec![command.to_owned()];
            argv.extend(args);
            if is_mcp_argv(&argv) {
                target = Target::Command(argv);
            } else {
                errors.push(McpDraftField::Args);
            }
        }
        match parse_env(&draft.env) {
            Some(parsed) => env = parsed,
            None => errors.push(McpDraftField::Env),
        }
    }
    if !secrets_valid(draft.transport, &draft.secrets) {
        errors.push(McpDraftField::Secrets);
    }
    if !errors.is_empty() {
        return McpDraftResult::Invalid { errors };
    }
    let kept: Vec<&SecretDraft> = draft
        .secrets
        .iter()
        .filter(|row| row.saved || !is_blank(&row.key, &row.value))
        .collect();
    let secrets: Vec<String> = kept
        .iter()
        .map(|row| js_trim(&row.key).to_owned())
        .collect();
    let mut secret_values = IndexMap::new();
    for row in &kept {
        if !row.value.is_empty() {
            secret_values.insert(js_trim(&row.key).to_owned(), row.value.clone());
        }
    }
    let (command, url) = match target {
        Target::Command(argv) => (Some(argv), None),
        Target::Url(url) => (None, Some(url)),
        Target::None => (None, None),
    };
    let server = McpServerSettings {
        name,
        enabled: original.is_none_or(|o| o.enabled),
        command,
        url,
        env,
        secrets: secrets.clone(),
        disabled_tools: original
            .map(|o| o.disabled_tools.clone())
            .unwrap_or_default(),
    };
    let removed_secrets = original
        .map(|o| {
            o.secrets
                .iter()
                .filter(|key| !secrets.contains(key))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    McpDraftResult::Valid {
        server,
        secret_values,
        removed_secrets,
    }
}

pub fn skills_in_folder(skills: &[SkillSummary], folder: &str) -> Vec<SkillSummary> {
    let prefix = format!("{}/", folder.trim_end_matches('/'));
    skills
        .iter()
        .filter(|skill| skill.path == folder || skill.path.starts_with(&prefix))
        .cloned()
        .collect()
}
