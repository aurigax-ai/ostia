use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REMOTE_SCHEME: &str = "remote://";
pub static REMOTE_FOLDER_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9]{12}$"));
pub static REMOTE_HOST_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._@:-]{1,330}$"));
pub static REMOTE_HOST_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._-]{1,253}$"));
pub static REMOTE_VERSION_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._:-]{1,80}$"));
pub const REMOTE_PATH_MAX: usize = 4096;
pub const REMOTE_NAME_MAX: usize = 255;
pub const REMOTE_ENTRIES_MAX: usize = 5000;
pub const REMOTE_FILE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const REMOTE_FOLDERS_PER_WORKSPACE: usize = 8;
pub const FOLDER_CLOSED_EVENT: &str = "folder.closed";

pub const REMOTE_WRITE_ANY: &str = "any";
pub const REMOTE_WRITE_NEW: &str = "new";

pub const REMOTE_FILE_ERRORS: [&str; 13] = [
    "unknown-folder",
    "invalid-path",
    "not-found",
    "not-file",
    "not-dir",
    "too-large",
    "binary",
    "changed",
    "denied",
    "outside",
    "read-only",
    "unavailable",
    "failed",
];

const FAILED: &str = "failed";
const REPLACEMENT: char = '\u{fffd}';

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    pub id: String,
    pub workspace_id: String,
    pub ext_id: String,
    pub ext_name: String,
    pub host: String,
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolderAsk {
    pub ext_name: String,
    pub host: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteCwd {
    pub host: String,
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub dir: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteParsedPath {
    pub folder_id: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteFileError(&'static str);

impl RemoteFileError {
    pub fn as_str(self) -> &'static str {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteFailure {
    pub ok: bool,
    pub error: RemoteFileError,
}

impl RemoteFailure {
    fn of(error: &'static str) -> Self {
        Self {
            ok: false,
            error: RemoteFileError(error),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteListing {
    pub ok: bool,
    pub entries: Vec<RemoteEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RemoteListResult {
    Listing(RemoteListing),
    Failure(RemoteFailure),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteStatFile {
    pub ok: bool,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RemoteStatResult {
    Stat(RemoteStatFile),
    Failure(RemoteFailure),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteContent {
    pub ok: bool,
    pub content: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RemoteReadResult {
    Content(RemoteContent),
    Failure(RemoteFailure),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteWritten {
    pub ok: bool,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RemoteWriteResult {
    Written(RemoteWritten),
    Failure(RemoteFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteFilesOp {
    List,
    Stat,
    Read,
    Write,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFilesRequest {
    pub op: RemoteFilesOp,
    pub folder_id: String,
    pub root: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version: Option<String>,
}

fn has_control_char(text: &str) -> bool {
    text.chars().any(|ch| ch < ' ' || ch == '\u{7f}')
}

pub fn normalize_remote_path(raw: &Value) -> Option<String> {
    let raw = raw.as_str()?;
    let length = utf16_len(raw);
    if length == 0 || length > REMOTE_PATH_MAX {
        return None;
    }
    if !raw.starts_with('/') || has_control_char(raw) || raw.contains(REPLACEMENT) {
        return None;
    }
    let mut kept: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => {}
            ".." => return None,
            _ => kept.push(segment),
        }
    }
    Some(format!("/{}", kept.join("/")))
}

pub fn is_inside_root(root: &str, path: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub fn remote_path(folder_id: &str, path: &str) -> String {
    format!("{REMOTE_SCHEME}{folder_id}{path}")
}

pub fn is_remote_path(path: Option<&str>) -> bool {
    path.is_some_and(|path| path.starts_with(REMOTE_SCHEME))
}

pub fn parse_remote_path(raw: &Value) -> Option<RemoteParsedPath> {
    let rest = raw.as_str()?.strip_prefix(REMOTE_SCHEME)?;
    let slash = rest.find('/')?;
    let (folder_id, path) = rest.split_at(slash);
    if !REMOTE_FOLDER_ID_PATTERN.is_match(folder_id) {
        return None;
    }
    let path = normalize_remote_path(&Value::String(path.to_owned()))?;
    Some(RemoteParsedPath {
        folder_id: folder_id.to_owned(),
        path,
    })
}

pub fn remote_child(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

pub fn normalize_remote_cwd(raw: &Value) -> Option<RemoteCwd> {
    let object = raw.as_object()?;
    let host = object.get("host")?.as_str()?;
    if !REMOTE_HOST_NAME_PATTERN.is_match(host) {
        return None;
    }
    let cwd = normalize_remote_path(object.get("cwd").unwrap_or(&Value::Null))?;
    Some(RemoteCwd {
        host: host.to_owned(),
        cwd,
    })
}

pub fn is_remote_name(name: &Value) -> bool {
    let Some(name) = name.as_str() else {
        return false;
    };
    let length = utf16_len(name);
    length > 0
        && length <= REMOTE_NAME_MAX
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains(REPLACEMENT)
        && !has_control_char(name)
}

fn failure_of(raw: &Value) -> RemoteFailure {
    let known = raw
        .get("error")
        .and_then(Value::as_str)
        .and_then(|error| REMOTE_FILE_ERRORS.iter().find(|known| **known == error));
    RemoteFailure::of(known.copied().unwrap_or(FAILED))
}

fn succeeded(raw: &Value) -> bool {
    raw.get("ok") == Some(&Value::Bool(true))
}

pub fn normalize_remote_listing(raw: &Value) -> RemoteListResult {
    if !succeeded(raw) {
        return RemoteListResult::Failure(failure_of(raw));
    }
    let Some(items) = raw.get("entries").and_then(Value::as_array) else {
        return RemoteListResult::Failure(RemoteFailure::of(FAILED));
    };
    let mut entries: Vec<RemoteEntry> = Vec::new();
    let mut truncated = raw.get("truncated") == Some(&Value::Bool(true));
    for item in items {
        if entries.len() >= REMOTE_ENTRIES_MAX {
            truncated = true;
            break;
        }
        let name = item.get("name").unwrap_or(&Value::Null);
        if !is_remote_name(name) {
            continue;
        }
        let name = name.as_str().unwrap_or_default();
        if entries.iter().any(|entry| entry.name == name) {
            continue;
        }
        entries.push(RemoteEntry {
            name: name.to_owned(),
            dir: item.get("dir") == Some(&Value::Bool(true)),
        });
    }
    RemoteListResult::Listing(RemoteListing {
        ok: true,
        entries,
        truncated,
    })
}

fn version_of(raw: Option<&Value>) -> Option<String> {
    raw.and_then(Value::as_str)
        .filter(|version| REMOTE_VERSION_PATTERN.is_match(version))
        .map(str::to_owned)
}

pub fn normalize_remote_stat(raw: &Value) -> RemoteStatResult {
    if !succeeded(raw) {
        return RemoteStatResult::Failure(failure_of(raw));
    }
    match raw.get("kind").and_then(Value::as_str) {
        Some("dir") => RemoteStatResult::Stat(RemoteStatFile {
            ok: true,
            kind: "dir",
            version: None,
        }),
        Some("file") => RemoteStatResult::Stat(RemoteStatFile {
            ok: true,
            kind: "file",
            version: version_of(raw.get("version")),
        }),
        _ => RemoteStatResult::Failure(RemoteFailure::of(FAILED)),
    }
}

pub fn utf8_length(text: &str) -> usize {
    text.len()
}

pub fn normalize_remote_read(raw: &Value) -> RemoteReadResult {
    if !succeeded(raw) {
        return RemoteReadResult::Failure(failure_of(raw));
    }
    let version = version_of(raw.get("version"));
    let (Some(content), Some(version)) = (raw.get("content").and_then(Value::as_str), version)
    else {
        return RemoteReadResult::Failure(RemoteFailure::of(FAILED));
    };
    if utf16_len(content) > REMOTE_FILE_MAX_BYTES || utf8_length(content) > REMOTE_FILE_MAX_BYTES {
        return RemoteReadResult::Failure(RemoteFailure::of("too-large"));
    }
    if content.contains('\0') || content.contains(REPLACEMENT) {
        return RemoteReadResult::Failure(RemoteFailure::of("binary"));
    }
    RemoteReadResult::Content(RemoteContent {
        ok: true,
        content: content.to_owned(),
        version,
    })
}

pub fn normalize_remote_write(raw: &Value) -> RemoteWriteResult {
    if !succeeded(raw) {
        return RemoteWriteResult::Failure(failure_of(raw));
    }
    match version_of(raw.get("version")) {
        Some(version) => RemoteWriteResult::Written(RemoteWritten { ok: true, version }),
        None => RemoteWriteResult::Failure(RemoteFailure::of(FAILED)),
    }
}
