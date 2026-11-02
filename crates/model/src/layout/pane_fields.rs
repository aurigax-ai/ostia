use std::sync::Arc;

use ostia_contract::archive_paths::is_archive_path;
use ostia_contract::remote_folders::is_remote_path;
use ostia_workspaces::browser_device::BrowserDevice;
use ostia_workspaces::stored_resume::{ResumeFailure, StoredResume};

use super::tree::{all_panes, find_pane, same_nodes, same_tabs};
use super::types::{
    BrowserProfile, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode, TabsNode,
};

type PaneMap<'a> = &'a mut dyn FnMut(&Arc<PaneNode>) -> Arc<PaneNode>;

fn map_split(split: &Arc<SplitNode>, change: PaneMap<'_>) -> Arc<SplitNode> {
    let children: Vec<LayoutNode> = split
        .children
        .iter()
        .map(|child| map_node(child, change))
        .collect();
    if same_nodes(&children, &split.children) {
        return split.clone();
    }
    Arc::new(SplitNode {
        children,
        ..(**split).clone()
    })
}

fn map_tab(tab: &TabNode, change: PaneMap<'_>) -> TabNode {
    match tab {
        TabNode::Pane(pane) => TabNode::Pane(change(pane)),
        TabNode::Split(split) => TabNode::Split(map_split(split, change)),
    }
}

fn map_node(node: &LayoutNode, change: PaneMap<'_>) -> LayoutNode {
    match node {
        LayoutNode::Pane(pane) => LayoutNode::Pane(change(pane)),
        LayoutNode::Split(split) => LayoutNode::Split(map_split(split, change)),
        LayoutNode::Tabs(tabs) => {
            let children: Vec<TabNode> = tabs
                .children
                .iter()
                .map(|tab| map_tab(tab, change))
                .collect();
            if same_tabs(&children, &tabs.children) {
                return node.clone();
            }
            TabsNode {
                children,
                ..(**tabs).clone()
            }
            .into()
        }
    }
}

pub fn map_panes(
    node: &LayoutNode,
    mut change: impl FnMut(&Arc<PaneNode>) -> Arc<PaneNode>,
) -> LayoutNode {
    map_node(node, &mut change)
}

pub fn map_split_panes(
    split: &Arc<SplitNode>,
    mut change: impl FnMut(&Arc<PaneNode>) -> Arc<PaneNode>,
) -> Arc<SplitNode> {
    map_split(split, &mut change)
}

fn map_pane(
    root: &LayoutNode,
    pane_id: &str,
    change: impl Fn(&Arc<PaneNode>) -> Arc<PaneNode>,
) -> LayoutNode {
    map_panes(root, |pane| {
        if pane.id == pane_id {
            change(pane)
        } else {
            pane.clone()
        }
    })
}

fn edited(pane: &PaneNode, edit: impl FnOnce(&mut PaneNode)) -> Arc<PaneNode> {
    let mut next = pane.clone();
    edit(&mut next);
    Arc::new(next)
}

pub fn set_resume_pending(root: &LayoutNode, pane_id: &str, pending: bool) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.resume_pending == pending {
            return pane.clone();
        }
        edited(pane, |next| next.resume_pending = pending)
    })
}

pub fn set_pane_cwd(root: &LayoutNode, pane_id: &str, cwd: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.resume_folder_missing.as_deref() == Some(cwd) {
            return edited(pane, |next| {
                next.resume_folder_missing = None;
                next.cwd = Some(cwd.to_owned());
            });
        }
        if pane.cwd.as_deref() == Some(cwd) {
            return pane.clone();
        }
        edited(pane, |next| next.cwd = Some(cwd.to_owned()))
    })
}

pub fn set_pane_spawn_dir(root: &LayoutNode, pane_id: &str, spawn_dir: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.spawn_dir.as_deref() == Some(spawn_dir) {
            return pane.clone();
        }
        edited(pane, |next| next.spawn_dir = Some(spawn_dir.to_owned()))
    })
}

pub fn settle_spawn_dir(root: &LayoutNode, pane_id: &str, missing: bool) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let Some(spawn_dir) = &pane.spawn_dir else {
            return pane.clone();
        };
        edited(pane, |next| {
            next.spawn_dir = None;
            if missing {
                next.resume_folder_missing = Some(spawn_dir.clone());
            }
        })
    })
}

pub fn set_pane_url(root: &LayoutNode, pane_id: &str, url: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.url.as_deref() == Some(url) {
            return pane.clone();
        }
        edited(pane, |next| next.url = Some(url.to_owned()))
    })
}

fn name(pane: &mut PaneNode, title: &str) {
    pane.default_title = false;
    pane.title = title.to_owned();
}

pub fn set_pane_title(root: &LayoutNode, pane_id: &str, title: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.title_pinned || (pane.title == title && !pane.default_title) {
            return pane.clone();
        }
        edited(pane, |next| name(next, title))
    })
}

pub fn rename_pane(root: &LayoutNode, pane_id: &str, title: &str) -> LayoutNode {
    let new_name = title.trim();
    map_pane(root, pane_id, |pane| {
        if !new_name.is_empty() {
            if pane.title == new_name && pane.title_pinned {
                return pane.clone();
            }
            return edited(pane, |next| {
                name(next, new_name);
                next.title_pinned = true;
            });
        }
        if !pane.title_pinned {
            return pane.clone();
        }
        edited(pane, |next| next.title_pinned = false)
    })
}

fn with_default_title(pane: &Arc<PaneNode>, title: &str) -> Arc<PaneNode> {
    if pane.default_title && pane.title != title {
        return edited(pane, |next| next.title = title.to_owned());
    }
    pane.clone()
}

pub fn set_default_pane_title(root: &LayoutNode, pane_id: &str, title: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| with_default_title(pane, title))
}

pub fn set_default_pane_titles(root: &LayoutNode, title: &str) -> LayoutNode {
    map_panes(root, |pane| with_default_title(pane, title))
}

pub fn set_pane_resume(root: &LayoutNode, pane_id: &str, resume: &StoredResume) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.resume.as_ref() == Some(resume) && pane.resume_failed.is_none() {
            return pane.clone();
        }
        edited(pane, |next| {
            next.resume_folder_missing = None;
            next.resume_failed = None;
            let same_agent = next
                .resume
                .as_ref()
                .is_some_and(|old| old.resume.agent == resume.resume.agent);
            if !same_agent {
                next.keep_awake = false;
            }
            next.resume = Some(resume.clone());
        })
    })
}

pub fn fail_pane_resume(
    root: &LayoutNode,
    pane_id: &str,
    resume: &StoredResume,
    exit_code: i64,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let Some(failed) = pane.resume.as_ref().filter(|current| {
            current.resume.agent == resume.resume.agent && current.resume.id == resume.resume.id
        }) else {
            return pane.clone();
        };
        edited(pane, |next| {
            next.resume = None;
            next.resume_pending = false;
            next.keep_awake = false;
            next.resume_failed = Some(ResumeFailure {
                resume: failed.clone(),
                exit_code,
            });
        })
    })
}

pub fn clear_pane_resume_failure(root: &LayoutNode, pane_id: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.resume_failed.is_none() {
            return pane.clone();
        }
        edited(pane, |next| next.resume_failed = None)
    })
}

pub fn set_pane_hibernated(root: &LayoutNode, pane_id: &str, hibernated: bool) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.hibernated == hibernated {
            return pane.clone();
        }
        edited(pane, |next| {
            next.hibernated = hibernated;
            if hibernated {
                next.keep_awake = false;
            } else if let Some(cwd) = next
                .resume
                .as_ref()
                .and_then(|resume| resume.resume.cwd.as_ref())
                .filter(|cwd| !cwd.is_empty())
            {
                next.spawn_dir = Some(cwd.clone());
            }
        })
    })
}

pub fn set_pane_keep_awake(root: &LayoutNode, pane_id: &str, keep_awake: bool) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.keep_awake == keep_awake {
            return pane.clone();
        }
        edited(pane, |next| next.keep_awake = keep_awake)
    })
}

pub fn set_pane_locked(root: &LayoutNode, pane_id: &str, locked: bool) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.locked == locked {
            return pane.clone();
        }
        edited(pane, |next| next.locked = locked)
    })
}

pub fn has_locked_pane(root: &LayoutNode) -> bool {
    all_panes(root).iter().any(|pane| pane.locked)
}

pub fn first_pane_of_kind(node: &LayoutNode, kind: SurfaceKind) -> Option<Arc<PaneNode>> {
    all_panes(node).into_iter().find(|pane| pane.kind == kind)
}

pub fn base_name(path: &str) -> &str {
    match path.rfind('/') {
        Some(slash) if slash + 1 < path.len() => &path[slash + 1..],
        Some(_) => path,
        None => path,
    }
}

pub fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(slash) if slash > 0 => &path[..slash],
        _ => "/",
    }
}

fn as_editor(pane: &PaneNode, title: &str, file_path: &str) -> Arc<PaneNode> {
    edited(pane, |next| {
        next.view_type = None;
        next.kind = SurfaceKind::Editor;
        next.file_path = Some(file_path.to_owned());
        if is_remote_path(Some(file_path)) || is_archive_path(Some(file_path)) {
            next.cwd = None;
            next.title = title.to_owned();
        } else {
            name(next, title);
            next.cwd = Some(parent_of(file_path).to_owned());
        }
    })
}

pub fn set_pane_editor(
    root: &LayoutNode,
    pane_id: &str,
    title: &str,
    file_path: &str,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| as_editor(pane, title, file_path))
}

pub fn set_pane_view_type(root: &LayoutNode, pane_id: &str, view_type: Option<&str>) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.view_type.as_deref() == view_type {
            return pane.clone();
        }
        edited(pane, |next| next.view_type = view_type.map(str::to_owned))
    })
}

fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_owned());
    }
    path.strip_prefix(from)
        .filter(|rest| rest.starts_with('/'))
        .map(|rest| format!("{to}{rest}"))
}

pub fn follow_moved_file(root: &LayoutNode, from: &str, to: &str) -> LayoutNode {
    map_panes(root, |pane| {
        let moved = (pane.kind == SurfaceKind::Editor)
            .then_some(pane.file_path.as_deref())
            .flatten()
            .filter(|path| !path.is_empty())
            .and_then(|path| moved_path(path, from, to));
        match moved {
            Some(next) => as_editor(pane, base_name(&next), &next),
            None => pane.clone(),
        }
    })
}

fn title_from_url(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| url.to_owned())
}

pub fn set_pane_browser(
    root: &LayoutNode,
    pane_id: &str,
    url: &str,
    profile: Option<BrowserProfile>,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        edited(pane, |next| {
            name(next, &title_from_url(url));
            next.kind = SurfaceKind::Browser;
            next.url = Some(url.to_owned());
            if let Some(profile) = profile {
                next.browser_profile =
                    (profile == BrowserProfile::Shared).then_some(BrowserProfile::Shared);
            }
        })
    })
}

pub fn set_pane_browser_device(
    root: &LayoutNode,
    pane_id: &str,
    device: Option<&BrowserDevice>,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        if pane.kind != SurfaceKind::Browser || pane.browser_device.as_ref() == device {
            return pane.clone();
        }
        edited(pane, |next| next.browser_device = device.cloned())
    })
}

pub fn pane_browser_profile(pane: &PaneNode) -> BrowserProfile {
    pane.browser_profile.unwrap_or_default()
}

pub fn browser_pane_in_use(
    node: &LayoutNode,
    active_pane_id: &str,
    profile: BrowserProfile,
) -> Option<Arc<PaneNode>> {
    let is_match = |pane: &PaneNode| {
        pane.kind == SurfaceKind::Browser && pane_browser_profile(pane) == profile
    };
    find_pane(node, active_pane_id)
        .filter(|pane| is_match(pane))
        .or_else(|| all_panes(node).into_iter().find(|pane| is_match(pane)))
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}

pub fn set_pane_chat(
    root: &LayoutNode,
    pane_id: &str,
    title: &str,
    session_id: Option<&str>,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let mut next = PaneNode::new(pane.id.clone(), title, SurfaceKind::Chat);
        next.chat_session_id = non_empty(session_id);
        Arc::new(next)
    })
}

pub fn set_pane_agent(
    root: &LayoutNode,
    pane_id: &str,
    title: &str,
    session_id: Option<&str>,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let mut next = PaneNode::new(pane.id.clone(), title, SurfaceKind::Agent);
        next.agent_session_id = non_empty(session_id);
        Arc::new(next)
    })
}

pub fn set_pane_git(root: &LayoutNode, pane_id: &str, title: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        Arc::new(PaneNode::new(pane.id.clone(), title, SurfaceKind::Git))
    })
}

pub fn set_pane_view(root: &LayoutNode, pane_id: &str, view_name: &str, title: &str) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let mut next = PaneNode::new(pane.id.clone(), title, SurfaceKind::View);
        next.view_name = Some(view_name.to_owned());
        Arc::new(next)
    })
}

pub fn set_pane_diff(
    root: &LayoutNode,
    pane_id: &str,
    title: &str,
    cwd: Option<&str>,
) -> LayoutNode {
    map_pane(root, pane_id, |pane| {
        let mut next = PaneNode::new(pane.id.clone(), title, SurfaceKind::Diff);
        next.cwd = non_empty(cwd);
        Arc::new(next)
    })
}

pub fn is_remote_file_pane(pane: &PaneNode) -> bool {
    pane.kind == SurfaceKind::Editor && is_remote_path(pane.file_path.as_deref())
}

pub fn find_view_pane(node: &LayoutNode, view_name: &str) -> Option<Arc<PaneNode>> {
    all_panes(node)
        .into_iter()
        .find(|pane| pane.kind == SurfaceKind::View && pane.view_name.as_deref() == Some(view_name))
}
