use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::{Serialize, Serializer};
use serde_json::{Map, Number, Value};
use url::Url;

use crate::capabilities::Capability;
use crate::is_record::is_record;

pub const LANGUAGE_SERVER_CAPABILITY: Capability = Capability::LanguageServer;
pub static LANGUAGE_SERVER_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,39}$"));
pub static LANGUAGE_SERVER_PROGRAM_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_][A-Za-z0-9._+-]{0,63}$"));
pub static LANGUAGE_SERVER_SCRIPT_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\.(c|m)?js$"));
pub static LANGUAGE_SERVER_SUFFIX_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^\.[A-Za-z0-9._+-]{1,40}$"));
pub static LANGUAGE_SERVER_DOCUMENT_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z][A-Za-z0-9+#._-]{0,39}$"));
pub static LANGUAGE_SERVER_SETTING_PATH_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^[A-Za-z_][A-Za-z0-9_-]{0,39}(\.[A-Za-z_][A-Za-z0-9_-]{0,39}){0,7}$")
});
pub static LANGUAGE_SERVER_SHA256_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-f0-9]{64}$"));
pub static LANGUAGE_SERVER_EXECUTABLE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,99}(/[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,99}){0,7}$",
    )
});
pub static LANGUAGE_SERVER_GO_MODULE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(/[a-z0-9][a-z0-9._-]{0,63}){1,8}$",
    )
});
pub static LANGUAGE_SERVER_GO_VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(r"^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$")
});
static VERSION_BODY_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$"));
static ABSOLUTE_PATH_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(/|[A-Za-z]:[\\/])"));

pub const MAX_LANGUAGE_SERVERS: usize = 8;
pub const MAX_SERVER_LANGUAGES: usize = 16;
pub const MAX_SERVER_ARGS: usize = 32;
pub const SERVER_ARG_MAX: usize = 200;
pub const SERVER_NAME_MAX: usize = 200;
pub const MAX_ROOT_MARKERS: usize = 16;
pub const MAX_DOCUMENT_LANGUAGE_IDS: usize = 32;
pub const SERVER_JSON_MAX_BYTES: usize = 16 * 1024;
pub const EXTENSION_DIR_PLACEHOLDER: &str = "{extensionDir}";
pub const ROOT_PLACEHOLDER: &str = "{root}";
pub const DOWNLOAD_URL_MAX: usize = 500;
pub const GO_MODULE_MAX: usize = 200;
pub const SERVER_OVERRIDE_PATH_MAX: usize = 4096;
pub const LSP_LOG_MAX_ENTRIES: usize = 400;
pub const LSP_LOG_LINE_MAX: usize = 500;
const ROOT_MARKER_MAX: usize = 100;

pub const LANGUAGE_SERVER_DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
pub const LANGUAGE_SERVER_PLATFORMS: [&str; 6] = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
];
pub const LANGUAGE_SERVER_ARCHIVES: [&str; 4] = ["plain", "gz", "tar.gz", "zip"];

pub type JsonObject = Map<String, Value>;

pub fn is_pinned_version(text: &str) -> bool {
    !text.eq_ignore_ascii_case("latest") && VERSION_BODY_PATTERN.is_match(text)
}

pub fn is_root_marker(text: &str) -> bool {
    let length = utf16_len(text);
    (1..=ROOT_MARKER_MAX).contains(&length) && !text.contains(['/', '\\'])
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerNodeRun {
    pub node: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerProgramRun {
    pub program: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    pub args: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum LanguageServerPlatform {
    #[serde(rename = "linux-x64")]
    LinuxX64,
    #[serde(rename = "linux-arm64")]
    LinuxArm64,
    #[serde(rename = "darwin-x64")]
    DarwinX64,
    #[serde(rename = "darwin-arm64")]
    DarwinArm64,
    #[serde(rename = "win32-x64")]
    Win32X64,
    #[serde(rename = "win32-arm64")]
    Win32Arm64,
}

impl LanguageServerPlatform {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "linux-x64" => Some(Self::LinuxX64),
            "linux-arm64" => Some(Self::LinuxArm64),
            "darwin-x64" => Some(Self::DarwinX64),
            "darwin-arm64" => Some(Self::DarwinArm64),
            "win32-x64" => Some(Self::Win32X64),
            "win32-arm64" => Some(Self::Win32Arm64),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum LanguageServerArchive {
    #[serde(rename = "plain")]
    Plain,
    #[serde(rename = "gz")]
    Gz,
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

impl LanguageServerArchive {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "plain" => Some(Self::Plain),
            "gz" => Some(Self::Gz),
            "tar.gz" => Some(Self::TarGz),
            "zip" => Some(Self::Zip),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Plain => LANGUAGE_SERVER_ARCHIVES[0],
            Self::Gz => LANGUAGE_SERVER_ARCHIVES[1],
            Self::TarGz => LANGUAGE_SERVER_ARCHIVES[2],
            Self::Zip => LANGUAGE_SERVER_ARCHIVES[3],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerAsset {
    pub url: String,
    pub sha256: String,
    pub archive: LanguageServerArchive,
    pub executable: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlatformAssets(pub Vec<(LanguageServerPlatform, LanguageServerAsset)>);

impl Serialize for PlatformAssets {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|entry| (&entry.0, &entry.1)))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerDownload {
    pub program: String,
    pub version: String,
    pub assets: PlatformAssets,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerDownloadRun {
    pub download: LanguageServerDownload,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerGoInstall {
    pub module: String,
    pub version: String,
    pub binary: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerGoInstallRun {
    pub go_install: LanguageServerGoInstall,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LanguageServerRun {
    Node(LanguageServerNodeRun),
    Program(LanguageServerProgramRun),
    Download(LanguageServerDownloadRun),
    GoInstall(LanguageServerGoInstallRun),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerContribution {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_language_ids: Option<Vec<(String, String)>>,
    pub run: LanguageServerRun,
    pub root_markers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting_paths: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerSummaryDownload {
    pub program: String,
    pub version: String,
    pub host: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerSummaryGoInstall {
    pub command: String,
    pub binary: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerSummary {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download: Option<LanguageServerSummaryDownload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub go_install: Option<LanguageServerSummaryGoInstall>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerKind {
    Bundled,
    Program,
    Download,
    GoInstall,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerStatus {
    Running,
    Idle,
    Off,
    ProgramMissing,
    ToolchainMissing,
    Downloading,
    DownloadFailed,
    Installing,
    InstallFailed,
    SandboxUnavailable,
    OverrideInvalid,
    Crashed,
    PendingApproval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerFetchFailure {
    HostNotAllowed,
    RedirectRefused,
    HttpError,
    TooLarge,
    ChecksumMismatch,
    BadArchive,
    ExecutableMissing,
    Offline,
    Timeout,
    CommandFailed,
    WriteFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerBinarySource {
    Path,
    Managed,
    Override,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerBinary {
    pub source: LanguageServerBinarySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerOverride {
    pub path: String,
    pub args: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerOverrideProblem {
    NotAbsolute,
    Missing,
    NotFile,
    NotExecutable,
    BadArguments,
    UnknownServer,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerOverrideInfo {
    pub path: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<LanguageServerOverrideProblem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerSandboxProblem {
    ProgramUnreadable,
    FolderUnreadable,
    WrapFailed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerInfo {
    pub key: String,
    pub ext_id: String,
    pub ext_name: String,
    pub server_id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub kind: LanguageServerKind,
    pub command: String,
    pub enabled: bool,
    pub status: LanguageServerStatus,
    pub folders: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_problem: Option<LanguageServerSandboxProblem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<LanguageServerBinary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_copy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetchable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_held: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<LanguageServerFetchFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_command: Option<String>,
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    pub override_info: Option<LanguageServerOverrideInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LanguageServerOverrideResult {
    pub servers: Vec<LanguageServerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<LanguageServerOverrideProblem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSessionInfo {
    pub session_id: String,
    pub server_key: String,
    pub root: String,
    pub edit_root: Option<String>,
    pub language_id: String,
    pub initialization_options: JsonObject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LspStopReason {
    Idle,
    Restart,
    Off,
    Quit,
    Window,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LspFetchHow {
    Download,
    GoInstall,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LspLogEvent {
    Start {
        pid: u32,
        sandboxed: bool,
    },
    Initialized {
        name: String,
        version: String,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
    Restart {
        attempt: u32,
        limit: u32,
        delay_ms: u64,
    },
    Crashed,
    Stop {
        reason: LspStopReason,
    },
    SpawnFailed {
        text: String,
    },
    Stderr {
        text: String,
    },
    FetchStart {
        how: LspFetchHow,
        version: String,
    },
    FetchDone {
        version: String,
    },
    FetchFailed {
        reason: LanguageServerFetchFailure,
        detail: String,
    },
    FetchOutput {
        text: String,
    },
    FetchRemoved,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LspLogEntry {
    pub at: i64,
    #[serde(flatten)]
    pub event: LspLogEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LspLog {
    pub entries: Vec<LspLogEntry>,
    pub errors: HashMap<String, u32>,
}

pub fn has_control_character(value: &str) -> bool {
    value.chars().any(|ch| ch < '\u{20}' || ch == '\u{7f}')
}

pub fn parse_language_server_override(
    raw: &Value,
) -> Result<LanguageServerOverride, LanguageServerOverrideProblem> {
    use LanguageServerOverrideProblem::{BadArguments, NotAbsolute};
    if !is_record(raw) {
        return Err(NotAbsolute);
    }
    let path = raw
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| {
            utf16_len(path) <= SERVER_OVERRIDE_PATH_MAX
                && ABSOLUTE_PATH_PATTERN.is_match(path)
                && !has_control_character(path)
        })
        .ok_or(NotAbsolute)?;
    let args = match raw.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(list) => list
            .as_array()
            .filter(|items| items.len() <= MAX_SERVER_ARGS)
            .and_then(|items| {
                items
                    .iter()
                    .map(|arg| {
                        arg.as_str()
                            .filter(|arg| {
                                !arg.is_empty()
                                    && utf16_len(arg) <= SERVER_ARG_MAX
                                    && !has_control_character(arg)
                            })
                            .map(str::to_owned)
                    })
                    .collect::<Option<Vec<String>>>()
            })
            .ok_or(BadArguments)?,
    };
    Ok(LanguageServerOverride {
        path: path.to_owned(),
        args,
    })
}

pub fn language_server_key(ext_id: &str, server_id: &str) -> String {
    format!("{ext_id}/{server_id}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageServerKeyParts {
    pub ext_id: String,
    pub server_id: String,
}

pub fn split_language_server_key(key: &Value) -> Option<LanguageServerKeyParts> {
    let key = key.as_str()?;
    let slash = key.find('/')?;
    if slash == 0 || slash == key.len() - 1 || key[slash + 1..].contains('/') {
        return None;
    }
    Some(LanguageServerKeyParts {
        ext_id: key[..slash].to_owned(),
        server_id: key[slash + 1..].to_owned(),
    })
}

pub fn language_server_feature(key: &str) -> String {
    format!("lsp:{key}")
}

pub fn language_server_kind(run: &LanguageServerRun) -> LanguageServerKind {
    match run {
        LanguageServerRun::Node(_) => LanguageServerKind::Bundled,
        LanguageServerRun::Download(_) => LanguageServerKind::Download,
        LanguageServerRun::GoInstall(_) => LanguageServerKind::GoInstall,
        LanguageServerRun::Program(_) => LanguageServerKind::Program,
    }
}

pub fn run_args(run: &LanguageServerRun) -> &[String] {
    match run {
        LanguageServerRun::Node(run) => &run.args,
        LanguageServerRun::Program(run) => &run.args,
        LanguageServerRun::Download(run) => &run.args,
        LanguageServerRun::GoInstall(run) => &run.args,
    }
}

pub fn path_program(run: &LanguageServerRun) -> Option<&str> {
    match run {
        LanguageServerRun::Node(_) => None,
        LanguageServerRun::Program(run) => Some(&run.program),
        LanguageServerRun::Download(run) => Some(&run.download.program),
        LanguageServerRun::GoInstall(run) => Some(&run.go_install.binary),
    }
}

pub fn pinned_version(run: &LanguageServerRun) -> Option<&str> {
    match run {
        LanguageServerRun::Download(run) => Some(&run.download.version),
        LanguageServerRun::GoInstall(run) => Some(&run.go_install.version),
        LanguageServerRun::Node(_) | LanguageServerRun::Program(_) => None,
    }
}

pub fn go_install_args(install: &LanguageServerGoInstall) -> Vec<String> {
    vec![
        "install".to_owned(),
        format!("{}@{}", install.module, install.version),
    ]
}

pub fn language_server_command(run: &LanguageServerRun) -> String {
    let head = match run {
        LanguageServerRun::Node(run) => Some(run.node.as_str()),
        other => path_program(other),
    };
    std::iter::once(head.unwrap_or_default())
        .chain(run_args(run).iter().map(String::as_str))
        .collect::<Vec<&str>>()
        .join(" ")
}

pub fn language_server_summary(server: &LanguageServerContribution) -> LanguageServerSummary {
    let download = match &server.run {
        LanguageServerRun::Download(run) => {
            run.download
                .assets
                .0
                .first()
                .map(|(_, first)| LanguageServerSummaryDownload {
                    program: run.download.program.clone(),
                    version: run.download.version.clone(),
                    host: Url::parse(&first.url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_owned))
                        .unwrap_or_default(),
                })
        }
        _ => None,
    };
    let go_install = match &server.run {
        LanguageServerRun::GoInstall(run) => Some(LanguageServerSummaryGoInstall {
            command: std::iter::once("go".to_owned())
                .chain(go_install_args(&run.go_install))
                .collect::<Vec<String>>()
                .join(" "),
            binary: run.go_install.binary.clone(),
        }),
        _ => None,
    };
    LanguageServerSummary {
        id: server.id.clone(),
        name: server.name.clone(),
        languages: server.languages.clone(),
        command: language_server_command(&server.run),
        download,
        go_install,
    }
}
