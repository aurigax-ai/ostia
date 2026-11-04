use std::sync::LazyLock;

use indexmap::IndexMap;
use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use url::Url;

use crate::assist::CHAT_TOOL_NAME_PATTERN;
use crate::proto_guard::is_dangerous_segment;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatToolAccess {
    Read,
    Act,
    Write,
    Command,
}

pub const BUILTIN_TOOL_ACCESS: [(&str, ChatToolAccess); 11] = [
    ("read_file", ChatToolAccess::Read),
    ("list_directory", ChatToolAccess::Read),
    ("search_files", ChatToolAccess::Read),
    ("terminal_context", ChatToolAccess::Read),
    ("git_status", ChatToolAccess::Read),
    ("load_skill", ChatToolAccess::Read),
    ("propose_command", ChatToolAccess::Command),
    ("edit_file", ChatToolAccess::Write),
    ("write_file", ChatToolAccess::Write),
    ("open_file", ChatToolAccess::Act),
    ("open_url", ChatToolAccess::Act),
];

pub fn builtin_tool_access(name: &str) -> Option<ChatToolAccess> {
    BUILTIN_TOOL_ACCESS
        .iter()
        .find(|(tool, _)| *tool == name)
        .map(|(_, access)| *access)
}

const MCP_TOOL_PREFIX: &str = "mcp__";
pub static MCP_SERVER_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$"));
pub static MCP_ENV_KEY: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"));
static MCP_HEADER_KEY: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$"));
const MCP_ARGS_MAX: usize = 64;
const MCP_ARG_MAX: usize = 4096;
pub const MCP_ENV_MAX: usize = 32;
pub const MCP_SECRETS_MAX: usize = 8;
const MCP_URL_MAX: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpTransportKind {
    Stdio,
    Http,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerSettings {
    pub name: String,
    pub enabled: bool,
    pub command: Option<Vec<String>>,
    pub url: Option<String>,
    pub env: IndexMap<String, String>,
    pub secrets: Vec<String>,
    pub disabled_tools: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub path: String,
}

pub fn is_mcp_url(value: &str) -> bool {
    if utf16_len(value) > MCP_URL_MAX {
        return false;
    }
    Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn has_control_chars(text: &str) -> bool {
    text.chars().any(|ch| u32::from(ch) < 0x20)
}

pub fn is_mcp_argv(value: &[String]) -> bool {
    !value.is_empty()
        && value.len() <= MCP_ARGS_MAX
        && !value[0].is_empty()
        && value
            .iter()
            .all(|arg| utf16_len(arg) <= MCP_ARG_MAX && !has_control_chars(arg))
}

pub fn mcp_transport_of(server: &McpServerSettings) -> McpTransportKind {
    if server.url.as_deref().is_some_and(|url| !url.is_empty()) {
        McpTransportKind::Http
    } else {
        McpTransportKind::Stdio
    }
}

pub fn is_mcp_secret_key(transport: McpTransportKind, key: &str) -> bool {
    if is_dangerous_segment(key) {
        return false;
    }
    match transport {
        McpTransportKind::Http => MCP_HEADER_KEY.is_match(key),
        McpTransportKind::Stdio => MCP_ENV_KEY.is_match(key),
    }
}

fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_TOOL_PREFIX) && CHAT_TOOL_NAME_PATTERN.is_match(name)
}

pub const READ_OUTSIDE_GRANT: &str = "read-outside";

pub fn is_standing_chat_grant(key: &str) -> bool {
    if key == READ_OUTSIDE_GRANT {
        return true;
    }
    match builtin_tool_access(key) {
        Some(access) => access == ChatToolAccess::Act,
        None => is_mcp_tool_name(key),
    }
}
