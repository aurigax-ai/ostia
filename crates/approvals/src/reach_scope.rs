use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::js::js_trim;
use ostia_base::node_path;
use ostia_base::path_guard::{expand_home, is_inside_path};
use ostia_contract::reach::ReachMode;
use ostia_contract::sandbox::{WorkspaceSandbox, sandbox_merge_refusal};
use parking_lot::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeGroup {
    pub id: String,
    pub by_agent: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScopeWorkspace {
    pub id: String,
    pub shareable: bool,
    pub project: Option<String>,
    pub folder_by_agent: bool,
    pub sandbox: WorkspaceSandbox,
    pub group: Option<ScopeGroup>,
}

fn same_group(a: &ScopeWorkspace, b: &ScopeWorkspace) -> bool {
    match (&a.group, &b.group) {
        (Some(left), Some(right)) => left.id == right.id,
        _ => false,
    }
}

fn group_by_agent(workspace: &ScopeWorkspace) -> bool {
    workspace.group.as_ref().is_some_and(|group| group.by_agent)
}

pub fn same_reach_scope(caller: &ScopeWorkspace, target: &ScopeWorkspace, mode: ReachMode) -> bool {
    if caller.id.is_empty() || target.id.is_empty() {
        return false;
    }
    if caller.id == target.id {
        return true;
    }
    if mode == ReachMode::Workspace {
        return false;
    }
    if !caller.shareable || !target.shareable {
        return false;
    }
    if caller.sandbox.enabled {
        return false;
    }
    if sandbox_merge_refusal(&caller.sandbox, &target.sandbox).is_some() {
        return false;
    }
    if mode == ReachMode::Project {
        return caller.project.is_some()
            && caller.project == target.project
            && !caller.folder_by_agent
            && !target.folder_by_agent;
    }
    same_group(caller, target) && !group_by_agent(caller) && !group_by_agent(target)
}

fn marked_by_agent(workspace: &ScopeWorkspace, mode: ReachMode) -> bool {
    match mode {
        ReachMode::Project => workspace.folder_by_agent,
        ReachMode::Group => group_by_agent(workspace),
        ReachMode::Workspace => false,
    }
}

fn confirmed(workspace: &ScopeWorkspace) -> ScopeWorkspace {
    ScopeWorkspace {
        folder_by_agent: false,
        group: workspace.group.as_ref().map(|group| ScopeGroup {
            by_agent: false,
            ..group.clone()
        }),
        ..workspace.clone()
    }
}

pub fn unconfirmed_members(
    caller: &ScopeWorkspace,
    target: &ScopeWorkspace,
    mode: ReachMode,
) -> Vec<String> {
    if same_reach_scope(caller, target, mode) {
        return Vec::new();
    }
    if !same_reach_scope(&confirmed(caller), &confirmed(target), mode) {
        return Vec::new();
    }
    [caller, target]
        .into_iter()
        .filter(|workspace| marked_by_agent(workspace, mode))
        .map(|workspace| workspace.id.clone())
        .collect()
}

fn real_or(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_trimmed(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(js_trim(&String::from_utf8_lossy(&bytes)).to_owned())
}

fn resolve_from(base: &Path, raw: &str) -> PathBuf {
    if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        node_path::resolve(Path::new(raw), base)
    }
}

fn common_git_dir(dot_git: &Path) -> Option<PathBuf> {
    if fs::metadata(dot_git).ok()?.is_dir() {
        return Some(real_or(dot_git));
    }
    let line = read_trimmed(dot_git)?;
    let raw = js_trim(line.strip_prefix("gitdir:")?);
    let parent = dot_git.parent().unwrap_or_else(|| Path::new("/"));
    let git_dir = resolve_from(parent, raw);
    match read_trimmed(&node_path::join(&git_dir, "commondir")) {
        Some(common) => Some(real_or(&resolve_from(&git_dir, &common))),
        None => Some(real_or(&git_dir)),
    }
}

pub fn project_key(work_dir: &str, home: &Path) -> Option<String> {
    let expanded = expand_home(work_dir, home);
    if !expanded.has_root() {
        return None;
    }
    let dir = real_or(&node_path::normalize(&expanded));
    let real_home = real_or(home);
    if is_inside_path(&dir, &real_home) {
        return None;
    }
    let mut at = dir.clone();
    while at != real_home {
        let Some(parent) = at.parent() else { break };
        if let Some(common) = common_git_dir(&at.join(".git")) {
            return Some(format!("git:{}", common.to_string_lossy()));
        }
        at = parent.to_path_buf();
    }
    Some(format!("dir:{}", dir.to_string_lossy()))
}

#[derive(Default)]
pub struct AgentProvenance {
    placed: Mutex<HashMap<String, String>>,
}

impl AgentProvenance {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_by_agent(&self, workspace_id: &str, value: &str) {
        self.placed
            .lock()
            .insert(workspace_id.to_owned(), value.to_owned());
    }

    pub fn by_agent(&self, workspace_id: &str, value: &str) -> bool {
        self.placed
            .lock()
            .get(workspace_id)
            .is_some_and(|placed| placed == value)
    }

    pub fn confirm(&self, workspace_id: &str) {
        self.placed.lock().remove(workspace_id);
    }

    pub fn forget(&self, workspace_id: &str) {
        self.placed.lock().remove(workspace_id);
    }

    pub fn entries(&self) -> Vec<(String, String)> {
        self.placed
            .lock()
            .iter()
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect()
    }
}
