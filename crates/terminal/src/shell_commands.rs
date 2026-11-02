use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::SystemTime;

use ostia_base::js::{is_js_space, non_empty};
use ostia_sandbox::visibility::{SandboxReadRules, sandbox_path};
use parking_lot::Mutex;
use tokio::task::JoinHandle;

const SHELL_STATE_CAP_BYTES: u64 = 1024 * 1024;

const SHELL_STATE_HEADER_LINES: usize = 4;

const MAX_CACHED_PATHS: usize = 16;

const EXECUTE_BITS: u32 = 0o111;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellState {
    pub path: String,
    pub virtual_env: Option<String>,
    pub conda_env: Option<String>,
    pub kubeconfig: Option<String>,
    pub hist_file: Option<String>,
    pub names: Vec<String>,
}

fn line_or_none(line: Option<&str>) -> Option<String> {
    non_empty(line).map(str::to_owned)
}

pub fn parse_shell_state(text: &str) -> Option<ShellState> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= SHELL_STATE_HEADER_LINES {
        return None;
    }
    Some(ShellState {
        path: lines[0].to_owned(),
        virtual_env: line_or_none(lines.get(1).copied()),
        conda_env: line_or_none(lines.get(2).copied()),
        kubeconfig: line_or_none(lines.get(3).copied()),
        hist_file: line_or_none(lines.get(5).copied()),
        names: lines[4]
            .split(is_js_space)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

fn read_shell_state_blocking(file: &Path) -> Option<ShellState> {
    let info = std::fs::symlink_metadata(file).ok()?;
    if !info.is_file() || info.len() > SHELL_STATE_CAP_BYTES {
        return None;
    }
    let bytes = std::fs::read(file).ok()?;
    parse_shell_state(&String::from_utf8_lossy(&bytes))
}

pub async fn read_shell_state(file: &Path) -> Option<ShellState> {
    let file = file.to_owned();
    tokio::task::spawn_blocking(move || read_shell_state_blocking(&file))
        .await
        .ok()
        .flatten()
}

pub fn path_dirs(path: &str, separator: char) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut dirs = Vec::new();
    for dir in path.split(separator) {
        if !dir.is_empty() && Path::new(dir).is_absolute() && seen.insert(dir) {
            dirs.push(dir.to_owned());
        }
    }
    dirs
}

fn executable_name(dir: &Path, name: &str, is_file: bool, is_symlink: bool) -> Option<String> {
    if !is_file && !is_symlink {
        return None;
    }
    let info = std::fs::metadata(dir.join(name)).ok()?;
    (info.is_file() && info.permissions().mode() & EXECUTE_BITS != 0).then(|| name.to_owned())
}

fn list_executables(dir: &str) -> Vec<String> {
    let dir = Path::new(dir);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            executable_name(dir, &name, kind.is_file(), kind.is_symlink())
        })
        .collect()
}

fn dir_stamp(dir: &str) -> Option<SystemTime> {
    std::fs::metadata(dir).ok()?.modified().ok()
}

struct CachedListing {
    path: String,
    stamps: Vec<Option<SystemTime>>,
    names: Vec<String>,
}

pub struct ExecutableIndex {
    cache: Mutex<Vec<CachedListing>>,
    separator: char,
}

async fn on_each_dir<T: Send + Default + 'static>(dirs: &[String], work: fn(&str) -> T) -> Vec<T> {
    let handles: Vec<JoinHandle<T>> = dirs
        .iter()
        .map(|dir| {
            let dir = dir.clone();
            tokio::task::spawn_blocking(move || work(&dir))
        })
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.unwrap_or_default());
    }
    out
}

fn sorted_by_utf16(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names.dedup();
    names
}

impl ExecutableIndex {
    pub fn new(separator: char) -> Self {
        Self {
            cache: Mutex::new(Vec::new()),
            separator,
        }
    }

    fn cached(&self, path: &str, stamps: &[Option<SystemTime>]) -> Option<Vec<String>> {
        let mut cache = self.cache.lock();
        let at = cache.iter().position(|entry| entry.path == path)?;
        let entry = cache.remove(at);
        let fresh = entry.stamps == stamps;
        let names = fresh.then(|| entry.names.clone());
        cache.push(entry);
        names
    }

    fn store(&self, listing: CachedListing) {
        let mut cache = self.cache.lock();
        cache.retain(|entry| entry.path != listing.path);
        cache.push(listing);
        if cache.len() > MAX_CACHED_PATHS {
            cache.remove(0);
        }
    }

    pub async fn list(&self, path: &str) -> Vec<String> {
        let dirs = path_dirs(path, self.separator);
        let stamps = on_each_dir(&dirs, dir_stamp).await;
        if let Some(names) = self.cached(path, &stamps) {
            return names;
        }
        let listed = on_each_dir(&dirs, list_executables).await;
        let names = sorted_by_utf16(listed.into_iter().flatten().collect());
        self.store(CachedListing {
            path: path.to_owned(),
            stamps,
            names: names.clone(),
        });
        names
    }
}

pub async fn command_names(
    index: &ExecutableIndex,
    path: &str,
    shell_names: &[String],
) -> Vec<String> {
    let mut names = index.list(path).await;
    names.extend(shell_names.iter().cloned());
    sorted_by_utf16(names)
}

pub struct CommandsPane {
    pub owners: HashSet<String>,
    pub local_prompt: bool,
    pub state_file: Option<std::path::PathBuf>,
    pub spawn_path: String,
    pub rules: Option<SandboxReadRules>,
}

pub async fn pane_command_names(
    index: &ExecutableIndex,
    pane: Option<&CommandsPane>,
    sender_id: &str,
) -> Vec<String> {
    let Some(pane) = pane else {
        return Vec::new();
    };
    if !pane.owners.contains(sender_id) || !pane.local_prompt {
        return Vec::new();
    }
    let state = match pane
        .state_file
        .as_deref()
        .filter(|file| !file.as_os_str().is_empty())
    {
        Some(file) => read_shell_state(file).await,
        None => None,
    };
    let path = state
        .as_ref()
        .map_or(pane.spawn_path.as_str(), |state| state.path.as_str());
    let path = match &pane.rules {
        Some(rules) => sandbox_path(path, rules),
        None => path.to_owned(),
    };
    let shell_names = state.map(|state| state.names).unwrap_or_default();
    command_names(index, &path, &shell_names).await
}
