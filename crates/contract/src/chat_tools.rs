use std::sync::LazyLock;

use indexmap::IndexMap;
use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::assist::CHAT_TOOL_NAME_PATTERN;
use crate::chat_edits::ChatEdit;
use crate::manager_settings::is_skill_path;
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
pub const MCP_SERVERS_MAX: usize = 16;
const MCP_ARGS_MAX: usize = 64;
const MCP_ARG_MAX: usize = 4096;
pub const MCP_ENV_MAX: usize = 32;
const MCP_ENV_VALUE_MAX: usize = 4096;
pub const MCP_SECRETS_MAX: usize = 8;
const MCP_URL_MAX: usize = 2048;
pub const MCP_TOOLS_PER_SERVER_MAX: usize = 64;
const MCP_DISABLED_TOOL_MAX: usize = 128;
const MCP_TOOL_NAME_MAX: usize = 64;
const CHAT_SKILL_FOLDERS_MAX: usize = 32;
pub const SKILL_FILE_MAX: usize = 256 * 1024;
pub const SKILL_DESCRIPTION_MAX: usize = 1024;
pub const SKILLS_MAX: usize = 128;
pub static SKILL_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatToolSettings {
    pub mcp_servers: Vec<McpServerSettings>,
    pub skill_folders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

fn string_list(raw: Option<&Value>, max: usize, ok: impl Fn(&str) -> bool) -> Vec<String> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if let Some(text) = item.as_str()
            && ok(text)
            && !out.iter().any(|existing| existing == text)
        {
            out.push(text.to_owned());
        }
        if out.len() == max {
            break;
        }
    }
    out
}

fn parse_argv(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    let argv: Option<Vec<String>> = items
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect();
    argv.filter(|argv| is_mcp_argv(argv))
}

fn parse_env(raw: Option<&Value>) -> IndexMap<String, String> {
    let mut env = IndexMap::new();
    let Some(Value::Object(entries)) = raw else {
        return env;
    };
    for (key, value) in entries {
        if env.len() == MCP_ENV_MAX {
            break;
        }
        if !MCP_ENV_KEY.is_match(key) || is_dangerous_segment(key) {
            continue;
        }
        let Some(text) = value.as_str() else {
            continue;
        };
        if utf16_len(text) > MCP_ENV_VALUE_MAX {
            continue;
        }
        env.insert(key.clone(), text.to_owned());
    }
    env
}

pub fn parse_mcp_server(raw: &Value) -> Option<McpServerSettings> {
    let name = raw.get("name")?.as_str()?;
    if !MCP_SERVER_NAME.is_match(name) {
        return None;
    }
    let url = raw.get("url");
    let command = raw.get("command");
    let has_url = url.is_some_and(|value| value.as_str() != Some(""));
    let has_command = command.is_some();
    if has_url == has_command {
        return None;
    }
    let url = match url {
        Some(value) if has_url => Some(value.as_str().filter(|text| is_mcp_url(text))?.to_owned()),
        _ => None,
    };
    let command = match command {
        Some(value) => Some(parse_argv(value)?),
        None => None,
    };
    let transport = if url.is_some() {
        McpTransportKind::Http
    } else {
        McpTransportKind::Stdio
    };
    let env = if transport == McpTransportKind::Stdio {
        parse_env(raw.get("env"))
    } else {
        IndexMap::new()
    };
    Some(McpServerSettings {
        name: name.to_owned(),
        enabled: raw.get("enabled") != Some(&Value::Bool(false)),
        command,
        url,
        env,
        secrets: string_list(raw.get("secrets"), MCP_SECRETS_MAX, |key| {
            is_mcp_secret_key(transport, key)
        }),
        disabled_tools: string_list(
            raw.get("disabledTools"),
            MCP_TOOLS_PER_SERVER_MAX * 4,
            |tool| utf16_len(tool) <= MCP_DISABLED_TOOL_MAX,
        ),
    })
}

pub fn parse_chat_tool_settings(raw: &Value) -> ChatToolSettings {
    let mut mcp_servers: Vec<McpServerSettings> = Vec::new();
    if let Some(Value::Array(items)) = raw.get("mcpServers") {
        for item in items {
            if mcp_servers.len() == MCP_SERVERS_MAX {
                break;
            }
            if let Some(server) = parse_mcp_server(item)
                && !mcp_servers.iter().any(|known| known.name == server.name)
            {
                mcp_servers.push(server);
            }
        }
    }
    ChatToolSettings {
        mcp_servers,
        skill_folders: string_list(raw.get("skillFolders"), CHAT_SKILL_FOLDERS_MAX, |folder| {
            is_skill_path(&Value::String(folder.to_owned()))
        }),
    }
}

pub fn mcp_tool_name(server: &str, tool: &str) -> String {
    let safe_tool: String = tool
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect();
    let mut units: Vec<u16> = format!("{MCP_TOOL_PREFIX}{server}__{safe_tool}")
        .encode_utf16()
        .collect();
    units.truncate(MCP_TOOL_NAME_MAX);
    String::from_utf16_lossy(&units)
}

fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_TOOL_PREFIX) && CHAT_TOOL_NAME_PATTERN.is_match(name)
}

pub const READ_OUTSIDE_GRANT: &str = "read-outside";

pub const CHAT_TOOL_GRANTS_MAX: usize = 256;

pub fn is_standing_chat_grant(key: &str) -> bool {
    if key == READ_OUTSIDE_GRANT {
        return true;
    }
    match builtin_tool_access(key) {
        Some(access) => access == ChatToolAccess::Act,
        None => is_mcp_tool_name(key),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpServerState {
    Off,
    Idle,
    Connecting,
    Ready,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpAuthState {
    Required,
    SigningIn,
    SignedIn,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub transport: McpTransportKind,
    pub state: McpServerState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
    pub secrets_set: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<McpAuthState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatFsError {
    OutsideFolder,
    NotAllowed,
    NotFound,
    NotAFile,
    NotADirectory,
    TooLarge,
    Binary,
    Invalid,
    Failed,
    Changed,
    ThroughSymlink,
    NoMatch,
    Ambiguous,
    NoChange,
    Unsaved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatFsFailure {
    pub error: ChatFsError,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

pub type ChatFsResult<T> = Result<T, ChatFsFailure>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatFsTarget {
    pub path: String,
    pub root: String,
    pub outside: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatReadRequest {
    #[serde(flatten)]
    pub target: ChatFsTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReadOutput {
    pub path: String,
    pub text: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub truncated: bool,
    pub version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatDirEntryKind {
    File,
    Dir,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatDirEntry {
    pub name: String,
    pub kind: ChatDirEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatListOutput {
    pub path: String,
    pub entries: Vec<ChatDirEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSearchRequest {
    #[serde(flatten)]
    pub target: ChatFsTarget,
    pub query: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSearchMatch {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSearchOutput {
    pub path: String,
    pub matches: Vec<ChatSearchMatch>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatPreviewRequest {
    pub path: String,
    pub root: String,
    pub dirty: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatPreviewOutput {
    pub path: String,
    pub exists: bool,
    pub text: String,
    pub version: Option<String>,
    pub outside: bool,
    pub symlink: bool,
    pub unsaved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChatPlanRequest {
    pub path: String,
    pub root: String,
    pub edits: Vec<ChatEdit>,
    pub outside: bool,
    pub dirty: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatPlanOutput {
    pub path: String,
    pub before: String,
    pub after: String,
    pub version: String,
    pub outside: bool,
    pub symlink: bool,
    pub unsaved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatWriteRequest {
    #[serde(flatten)]
    pub target: ChatFsTarget,
    pub symlinks: bool,
    pub content: String,
    pub base: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatWriteOutput {
    pub path: String,
    pub created: bool,
    pub bytes: u64,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatRestoreRequest {
    #[serde(flatten)]
    pub target: ChatFsTarget,
    pub symlinks: bool,
    pub expected: Option<String>,
    pub content: Option<String>,
    pub dirty: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatRestoreOutput {
    pub path: String,
    pub removed: bool,
    pub version: Option<String>,
}

pub type McpCallResult = Result<String, String>;

pub type McpSecretResult = Result<(), String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpSignInError {
    UnknownServer,
    NotHttp,
    InProgress,
    NotNeeded,
    EncryptionUnavailable,
    Browser,
    Timeout,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpSignInFailure {
    pub error: McpSignInError,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type McpSignInResult = Result<(), McpSignInFailure>;

pub type McpTestResult = Result<usize, String>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillLoaded {
    pub name: String,
    pub body: String,
    pub path: String,
}

pub type SkillLoadResult = Result<SkillLoaded, String>;

pub const CHAT_READ_LINES_MAX: usize = 2000;
pub const CHAT_LIST_MAX: usize = 500;
pub const CHAT_SEARCH_MATCHES_MAX: usize = 100;
pub const CHAT_SEARCH_FILES_MAX: usize = 5000;
pub const CHAT_SEARCH_FILE_MAX: usize = 1024 * 1024;
pub const CHAT_READ_FILE_MAX: usize = 4 * 1024 * 1024;
pub const CHAT_WRITE_MAX: usize = 1024 * 1024;
pub const CHAT_QUERY_MAX: usize = 200;
pub const CHAT_DIRTY_PATHS_MAX: usize = 256;
