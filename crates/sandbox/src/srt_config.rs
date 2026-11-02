use std::collections::HashSet;
use std::path::Path;

use ostia_base::Platform;
use ostia_base::js::non_empty;
use ostia_base::node_path;
use ostia_base::path_guard::{expand_home, is_inside_path};
use ostia_contract::sandbox::{DEFAULT_SWITCHES, SandboxSwitches};
use rustix::fs::{Access, access};
use serde::Serialize;

pub const SSH_AGENT_SOCKET_NAME: &str = "a.sock";

const AGENT_DATA_DIRS: [&str; 2] = [".claude", ".codex"];

const AGENT_PROTECTED_FILES: [&str; 8] = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks",
    ".claude/plugins",
    ".claude/CLAUDE.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/AGENTS.md",
];

const GIT_CONFIG_FILE: &str = ".git/config";
const ENVRC_FILE: &str = ".envrc";
const WORKDIR_PROTECTED_FILES: [&str; 2] = [".git/hooks", GIT_CONFIG_FILE];
pub const WORKDIR_HIDDEN_FILES: [&str; 1] = [".ostia/vault.json"];
pub const HOME_HIDDEN_FILES: [&str; 2] = [".cargo/credentials.toml", ".cargo/credentials"];

const CONTAINER_SOCKETS: [&str; 5] = [
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/containerd/containerd.sock",
    "/run/podman/podman.sock",
    "/run/crio/crio.sock",
];

const SECCOMP_ARCHS: [&str; 2] = ["x64", "arm64"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxFolderReason {
    Home,
    AboveHome,
    OstiaData,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SandboxBasePaths {
    pub home: String,
    pub data_dirs: Vec<String>,
    pub runtime_dir: Option<String>,
    pub socket_path: String,
    pub runtime_reads: Vec<String>,
    pub agent_sockets: Vec<String>,
    pub container_sockets: Vec<String>,
    pub tmp_root: Option<String>,
    pub codex_dir: Option<String>,
    pub srt_vendor_dir: Option<String>,
    pub kept_socket_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SandboxPaths {
    pub base: SandboxBasePaths,
    pub work_dir: String,
    pub tmp_dir: String,
    pub plugins_dir: Option<String>,
    pub hook_links: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixedWorkspace {
    pub work_dir: String,
    pub tmp_dir: String,
    pub plugins_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxFixedPolicy {
    pub readable: Vec<String>,
    pub writable: Vec<String>,
    pub hidden: Vec<String>,
    pub read_only: Vec<String>,
    pub hidden_sockets: Vec<String>,
    pub socket_blocking: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SrtPolicy {
    pub allow_read: Vec<String>,
    pub domains: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_read: Vec<String>,
    pub deny_write: Vec<String>,
    pub denied_domains: Vec<String>,
    pub allow_sockets: Vec<String>,
    pub switches: Option<SandboxSwitches>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrtNetwork {
    pub allowed_domains: Vec<String>,
    pub denied_domains: Vec<String>,
    pub strict_allowlist: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_unix_sockets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_all_unix_sockets: Option<bool>,
    pub allow_local_binding: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrtFilesystem {
    pub deny_read: Vec<String>,
    pub allow_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_write: Vec<String>,
    pub allow_git_config: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrtSeccomp {
    pub apply_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrtConfig {
    pub network: SrtNetwork,
    pub filesystem: SrtFilesystem,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_pty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_agent_jar_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seccomp: Option<SrtSeccomp>,
}

fn path_join(base: &str, rest: &str) -> String {
    let joined = if base.is_empty() {
        node_path::normalize(Path::new(rest))
    } else {
        node_path::join(Path::new(base), rest)
    };
    joined.to_string_lossy().into_owned()
}

fn dirname(path: &str) -> String {
    match Path::new(path).parent() {
        Some(parent) if parent.as_os_str().is_empty() => ".".to_owned(),
        Some(parent) => parent.to_string_lossy().into_owned(),
        None if path.is_empty() => ".".to_owned(),
        None => path.to_owned(),
    }
}

fn set(value: &Option<String>) -> Option<&str> {
    non_empty(value.as_deref())
}

fn inside(base: &str, path: &str) -> bool {
    is_inside_path(Path::new(base), Path::new(path))
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

fn expand(list: &[String], home: &str) -> Vec<String> {
    list.iter()
        .map(|path| {
            expand_home(path, Path::new(home))
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

pub fn can_connect(path: &str) -> bool {
    access(path, Access::READ_OK | Access::WRITE_OK).is_ok()
}

pub fn canonical_path(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|resolved| resolved.to_string_lossy().into_owned())
}

pub fn reachable_container_sockets(
    reachable: &dyn Fn(&str) -> bool,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    unique(
        CONTAINER_SOCKETS
            .iter()
            .filter(|candidate| reachable(candidate))
            .map(|candidate| resolve(candidate).unwrap_or_else(|| (*candidate).to_owned())),
    )
}

pub fn srt_vendor_dir(app_path: &str) -> String {
    let unpacked = app_path.strip_suffix(".asar").map_or_else(
        || app_path.to_owned(),
        |stem| format!("{stem}.asar.unpacked"),
    );
    path_join(
        &unpacked,
        "node_modules/@anthropic-ai/sandbox-runtime/vendor",
    )
}

pub fn real_path(path: &str) -> String {
    canonical_path(path).unwrap_or_else(|| path.to_owned())
}

fn overlaps(path: &str, other: &str) -> bool {
    inside(other, path) || inside(path, other)
}

fn touches_real(path: &str, guarded: &[String], guarded_real: &[String]) -> bool {
    let real = real_path(path);
    guarded
        .iter()
        .zip(guarded_real)
        .any(|(g, g_real)| overlaps(path, g) || overlaps(&real, g_real))
}

pub fn touches(path: &str, guarded: &[String]) -> bool {
    let guarded_real: Vec<String> = guarded.iter().map(|g| real_path(g)).collect();
    touches_real(path, guarded, &guarded_real)
}

pub fn protected_paths(paths: &SandboxBasePaths) -> Vec<String> {
    let mut out = paths.data_dirs.clone();
    out.extend(paths.agent_sockets.iter().map(|sock| dirname(sock)));
    out.extend(paths.container_sockets.iter().cloned());
    out.extend(set(&paths.runtime_dir).map(str::to_owned));
    out.extend(set(&paths.tmp_root).map(str::to_owned));
    out.extend(set(&paths.codex_dir).map(str::to_owned));
    out
}

pub fn protected_files(paths: &SandboxBasePaths, work_dir: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = AGENT_PROTECTED_FILES
        .iter()
        .map(|file| path_join(&paths.home, file))
        .collect();
    if let Some(work_dir) = work_dir.filter(|dir| !dir.is_empty()) {
        out.extend(
            [ENVRC_FILE]
                .iter()
                .chain(&WORKDIR_PROTECTED_FILES)
                .chain(&WORKDIR_HIDDEN_FILES)
                .map(|file| path_join(work_dir, file)),
        );
    }
    out
}

pub fn folder_problem(work_dir: &str, paths: &SandboxBasePaths) -> Option<SandboxFolderReason> {
    let folder = real_path(work_dir);
    let home = real_path(&paths.home);
    if inside(&folder, &home) {
        return Some(if inside(&home, &folder) {
            SandboxFolderReason::Home
        } else {
            SandboxFolderReason::AboveHome
        });
    }
    paths
        .data_dirs
        .iter()
        .any(|dir| overlaps(&folder, &real_path(dir)))
        .then_some(SandboxFolderReason::OstiaData)
}

pub fn can_block_sockets(platform: Platform, arch: &str) -> bool {
    platform == Platform::Darwin || (platform == Platform::Linux && SECCOMP_ARCHS.contains(&arch))
}

pub fn fixed_policy(
    paths: &SandboxBasePaths,
    workspace: Option<&FixedWorkspace>,
    git_config: bool,
    platform: Platform,
    arch: &str,
) -> SandboxFixedPolicy {
    let home = &paths.home;
    let agent_dirs: Vec<String> = AGENT_DATA_DIRS
        .iter()
        .map(|dir| path_join(home, dir))
        .collect();
    let existing_in_work_dir = |files: &[&str]| -> Vec<String> {
        workspace.map_or_else(Vec::new, |workspace| {
            files
                .iter()
                .filter(|file| Path::new(&path_join(&workspace.work_dir, file)).exists())
                .map(|file| (*file).to_owned())
                .collect()
        })
    };
    let work_dir = workspace.map_or("", |workspace| workspace.work_dir.as_str());
    let plugins_dir = workspace.and_then(|workspace| set(&workspace.plugins_dir));
    let hidden_files: Vec<String> = existing_in_work_dir(&WORKDIR_HIDDEN_FILES)
        .iter()
        .map(|file| path_join(work_dir, file))
        .collect();
    let hidden_sockets: Vec<String> = paths
        .agent_sockets
        .iter()
        .map(|sock| dirname(sock))
        .chain(paths.container_sockets.iter().cloned())
        .collect();
    let guarded_candidates: Vec<&str> = [ENVRC_FILE]
        .into_iter()
        .chain(
            WORKDIR_PROTECTED_FILES
                .into_iter()
                .filter(|file| !(git_config && *file == GIT_CONFIG_FILE)),
        )
        .collect();
    let guarded_in_work_dir = existing_in_work_dir(&guarded_candidates);

    let mut hidden = vec![home.clone()];
    hidden.extend(paths.data_dirs.iter().cloned());
    hidden.extend(HOME_HIDDEN_FILES.iter().map(|file| path_join(home, file)));
    hidden.extend(hidden_files.iter().cloned());
    hidden.extend(hidden_sockets.iter().cloned());
    hidden.extend(set(&paths.runtime_dir).map(str::to_owned));
    hidden.extend(set(&paths.tmp_root).map(str::to_owned));
    hidden.extend(set(&paths.codex_dir).map(str::to_owned));

    let mut readable = Vec::new();
    let mut writable = Vec::new();
    let mut read_only: Vec<String> = AGENT_PROTECTED_FILES
        .iter()
        .map(|file| path_join(home, file))
        .collect();
    if let Some(workspace) = workspace {
        readable.push(workspace.work_dir.clone());
        readable.push(workspace.tmp_dir.clone());
        writable.push(workspace.work_dir.clone());
        writable.push(workspace.tmp_dir.clone());
        read_only.extend(
            guarded_in_work_dir
                .iter()
                .map(|file| path_join(&workspace.work_dir, file)),
        );
    }
    readable.push(paths.socket_path.clone());
    readable.extend(agent_dirs.iter().cloned());
    readable.extend(plugins_dir.map(str::to_owned));
    readable.extend(paths.runtime_reads.iter().cloned());
    writable.extend(agent_dirs);
    read_only.extend(plugins_dir.map(str::to_owned));
    read_only.extend(hidden_files);

    SandboxFixedPolicy {
        hidden,
        readable,
        writable,
        read_only,
        hidden_sockets,
        socket_blocking: can_block_sockets(platform, arch),
    }
}

pub fn build_srt_config(
    policy: &SrtPolicy,
    paths: &SandboxPaths,
    platform: Platform,
    arch: &str,
) -> SrtConfig {
    let base = &paths.base;
    let home = base.home.as_str();
    let work_dir = &paths.work_dir;
    let tmp_dir = &paths.tmp_dir;
    let plugins_dir = set(&paths.plugins_dir);
    let switches = policy.switches.unwrap_or(DEFAULT_SWITCHES);
    let fixed = fixed_policy(
        base,
        Some(&FixedWorkspace {
            work_dir: work_dir.clone(),
            tmp_dir: tmp_dir.clone(),
            plugins_dir: plugins_dir.map(str::to_owned),
        }),
        switches.git_config,
        platform,
        arch,
    );
    let guarded = protected_paths(base);
    let guarded_real: Vec<String> = guarded.iter().map(|g| real_path(g)).collect();
    let deny_read = expand(&policy.deny_read, home);
    let hidden_by_human = |path: &str| deny_read.iter().any(|d| inside(d, path));
    let allowed = |path: &str| !touches_real(path, &guarded, &guarded_real);
    let opened = |list: &[String]| -> Vec<String> {
        expand(list, home)
            .into_iter()
            .filter(|path| allowed(path.as_str()) && !hidden_by_human(path.as_str()))
            .collect()
    };
    let agent_dirs: Vec<String> = AGENT_DATA_DIRS
        .iter()
        .map(|dir| path_join(home, dir))
        .filter(|dir| !hidden_by_human(dir.as_str()))
        .collect();
    let allow_write = opened(&policy.allow_write);
    let hook_links: Vec<String> = paths
        .hook_links
        .iter()
        .filter(|path| allowed(path.as_str()) && !hidden_by_human(path.as_str()))
        .cloned()
        .collect();
    let is_mac = platform == Platform::Darwin;
    let sockets = switches.unix_sockets;

    let mut allow_read = vec![work_dir.clone(), tmp_dir.clone(), base.socket_path.clone()];
    allow_read.extend(set(&base.kept_socket_path).map(str::to_owned));
    allow_read.extend(agent_dirs.iter().cloned());
    allow_read.extend(plugins_dir.map(str::to_owned));
    allow_read.extend(base.runtime_reads.iter().cloned());
    allow_read.extend(hook_links.iter().cloned());
    allow_read.extend(opened(&policy.allow_read));
    allow_read.extend(allow_write.iter().cloned());

    let mut writable = vec![work_dir.clone(), tmp_dir.clone()];
    writable.extend(agent_dirs);
    writable.extend(allow_write);

    let mut deny_write = fixed.read_only.clone();
    deny_write.extend(hook_links);
    deny_write.extend(expand(&policy.deny_write, home));

    let mut denied_reads = fixed.hidden.clone();
    denied_reads.extend(deny_read.iter().cloned());

    let (allow_unix_sockets, allow_all_unix_sockets) = if is_mac {
        let list = if sockets {
            let mut list = vec![base.socket_path.clone()];
            list.extend(set(&base.kept_socket_path).map(str::to_owned));
            list.push(path_join(tmp_dir, SSH_AGENT_SOCKET_NAME));
            list.extend(
                expand(&policy.allow_sockets, home)
                    .into_iter()
                    .filter(|path| allowed(path.as_str())),
            );
            list
        } else {
            Vec::new()
        };
        (Some(list), None)
    } else {
        (None, Some(sockets))
    };

    let vendored = set(&base.srt_vendor_dir);
    SrtConfig {
        network: SrtNetwork {
            allowed_domains: policy.domains.clone(),
            denied_domains: policy.denied_domains.clone(),
            strict_allowlist: switches.strict_domains,
            allow_unix_sockets,
            allow_all_unix_sockets,
            allow_local_binding: is_mac,
        },
        filesystem: SrtFilesystem {
            deny_read: unique(denied_reads),
            allow_read: unique(allow_read),
            allow_write: unique(writable),
            deny_write: unique(deny_write),
            allow_git_config: switches.git_config,
        },
        allow_pty: is_mac.then_some(true),
        java_agent_jar_path: vendored
            .map(|dir| path_join(dir, "java-proxy-agent/srt-proxy-agent.jar")),
        seccomp: vendored
            .filter(|_| platform == Platform::Linux && SECCOMP_ARCHS.contains(&arch))
            .map(|dir| SrtSeccomp {
                apply_path: path_join(dir, &format!("seccomp/{arch}/apply-seccomp")),
            }),
    }
}
