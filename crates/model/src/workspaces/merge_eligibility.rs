use ostia_base::js::{js_trim, non_empty};
use ostia_contract::sandbox::{SandboxMergeRefusal, WorkspaceSandbox, sandbox_merge_refusal};

use crate::sidebar::group_peers::WorkspaceKind;

#[derive(Clone, Debug, PartialEq)]
pub struct MergeSide {
    pub id: String,
    pub kind: WorkspaceKind,
    pub work_dir: String,
    pub project_dir: Option<String>,
    pub window_id: Option<String>,
    pub sandbox: Option<WorkspaceSandbox>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeRefusal {
    SelfTarget,
    Manager,
    OtherPath,
    OtherWindow,
    SandboxMixed,
    SandboxDiffers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeOptionRefusal {
    OtherWindow,
    SandboxMixed,
    SandboxDiffers,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PathOwner {
    pub work_dir: String,
    pub project_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeOption {
    pub target_id: String,
    pub refusal: Option<MergeOptionRefusal>,
}

fn expand_home(path: &str, home: Option<&str>) -> String {
    match home.filter(|home| !home.is_empty()) {
        Some(home) if path == "~" || path.starts_with("~/") => format!("{home}{}", &path[1..]),
        _ => path.to_owned(),
    }
}

fn normalize_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let tilde = path == "~" || path.starts_with("~/");
    let body = if tilde { &path[1..] } else { path };
    let mut parts: Vec<&str> = Vec::new();
    for part in body.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if tilde {
        if joined.is_empty() {
            "~".to_owned()
        } else {
            format!("~/{joined}")
        }
    } else if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

fn path_of(work_dir: &str, project_dir: Option<&str>, home: Option<&str>) -> String {
    let raw = non_empty(project_dir.map(js_trim)).unwrap_or_else(|| js_trim(work_dir));
    normalize_path(&expand_home(&normalize_path(raw), home))
}

pub fn infer_home(workspaces: &[PathOwner]) -> Option<String> {
    for owner in workspaces {
        let Some(display) = non_empty(owner.project_dir.as_deref()) else {
            continue;
        };
        if display != "~" && !display.starts_with("~/") {
            continue;
        }
        let rest = normalize_path(display);
        let rest = &rest[1..];
        let dir = normalize_path(&owner.work_dir);
        if !dir.starts_with('/') || !dir.ends_with(rest) {
            continue;
        }
        let home = &dir[..dir.len() - rest.len()];
        if home.starts_with('/') && home.len() > 1 {
            return Some(home.to_owned());
        }
    }
    None
}

pub fn workspace_path(owner: &PathOwner, home: Option<&str>) -> String {
    path_of(&owner.work_dir, owner.project_dir.as_deref(), home)
}

pub fn merge_refusal(
    source: &MergeSide,
    target: &MergeSide,
    home: Option<&str>,
) -> Option<MergeRefusal> {
    if source.id == target.id {
        return Some(MergeRefusal::SelfTarget);
    }
    if source.kind == WorkspaceKind::Manager || target.kind == WorkspaceKind::Manager {
        return Some(MergeRefusal::Manager);
    }
    let source_path = path_of(&source.work_dir, source.project_dir.as_deref(), home);
    let target_path = path_of(&target.work_dir, target.project_dir.as_deref(), home);
    if source_path != target_path {
        return Some(MergeRefusal::OtherPath);
    }
    if source.window_id != target.window_id {
        return Some(MergeRefusal::OtherWindow);
    }
    let empty = WorkspaceSandbox::empty();
    sandbox_merge_refusal(
        source.sandbox.as_ref().unwrap_or(&empty),
        target.sandbox.as_ref().unwrap_or(&empty),
    )
    .map(|refusal| match refusal {
        SandboxMergeRefusal::Mixed => MergeRefusal::SandboxMixed,
        SandboxMergeRefusal::Differs => MergeRefusal::SandboxDiffers,
    })
}

pub fn merge_options(
    source: &MergeSide,
    candidates: &[MergeSide],
    home: Option<&str>,
) -> Vec<MergeOption> {
    let mut options = Vec::new();
    for target in candidates {
        let refusal = match merge_refusal(source, target, home) {
            None => None,
            Some(MergeRefusal::OtherWindow) => Some(MergeOptionRefusal::OtherWindow),
            Some(MergeRefusal::SandboxMixed) => Some(MergeOptionRefusal::SandboxMixed),
            Some(MergeRefusal::SandboxDiffers) => Some(MergeOptionRefusal::SandboxDiffers),
            Some(MergeRefusal::SelfTarget | MergeRefusal::Manager | MergeRefusal::OtherPath) => {
                continue;
            }
        };
        options.push(MergeOption {
            target_id: target.id.clone(),
            refusal,
        });
    }
    options
}
