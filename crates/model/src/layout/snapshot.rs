use std::collections::{BTreeMap, HashSet};

use ostia_base::js::JsNumber;
use ostia_workspaces::workspace_snapshot::model::{
    AppSnapshot, BrowserProfile as SnapshotProfile, LeftPanel, SnapshotGroup, SnapshotNode,
    SnapshotPane, SnapshotSplit, SnapshotTabItem, SnapshotTabs, SnapshotWorkspace,
    SurfaceKind as SnapshotKind, WorkspaceKind, WorkspaceOrigin,
};

use super::collapse::settle_collapse;
use super::pane_fields::is_remote_file_pane;
use super::tree::{TERMINAL_TITLE, adopt_ids, find_pane, first_pane_id, without_panes};
use super::types::{
    BrowserProfile, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode, TabsNode,
};
use crate::ids::IdMint;

#[derive(Clone, Debug, PartialEq)]
pub struct RestorableWorkspace {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub description: Option<String>,
    pub pinned: bool,
    pub group_id: Option<String>,
    pub kind: WorkspaceKind,
    pub work_dir: String,
    pub project_dir: Option<String>,
    pub anchored: bool,
    pub origin: Option<WorkspaceOrigin>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RestorableLayout {
    pub root: LayoutNode,
    pub active_pane_id: String,
}

fn snapshot_kind(kind: SurfaceKind) -> SnapshotKind {
    match kind {
        SurfaceKind::Editor => SnapshotKind::Editor,
        SurfaceKind::Agent => SnapshotKind::Agent,
        SurfaceKind::Browser => SnapshotKind::Browser,
        SurfaceKind::Chat => SnapshotKind::Chat,
        SurfaceKind::Git => SnapshotKind::Git,
        SurfaceKind::View => SnapshotKind::View,
        SurfaceKind::Terminal | SurfaceKind::Diff | SurfaceKind::Manager => SnapshotKind::Terminal,
    }
}

fn layout_kind(kind: SnapshotKind) -> SurfaceKind {
    match kind {
        SnapshotKind::Terminal => SurfaceKind::Terminal,
        SnapshotKind::Editor => SurfaceKind::Editor,
        SnapshotKind::Agent => SurfaceKind::Agent,
        SnapshotKind::Browser => SurfaceKind::Browser,
        SnapshotKind::Chat => SurfaceKind::Chat,
        SnapshotKind::Git => SurfaceKind::Git,
        SnapshotKind::View => SurfaceKind::View,
    }
}

fn from_pane(pane: &PaneNode, live: &HashSet<String>) -> SnapshotPane {
    let keep_hibernated = pane.hibernated && pane.resume.is_some();
    let agent_running = !keep_hibernated
        && pane.resume.is_some()
        && (live.contains(&pane.id) || pane.resume_pending);
    SnapshotPane {
        cwd: pane.cwd.clone(),
        file_path: pane.file_path.clone(),
        view_type: pane.view_type.clone(),
        url: pane.url.clone(),
        chat_session_id: pane.chat_session_id.clone(),
        agent_session_id: pane.agent_session_id.clone(),
        browser_profile: (pane.browser_profile == Some(BrowserProfile::Shared))
            .then_some(SnapshotProfile::Shared),
        browser_device: pane.browser_device.clone(),
        view_name: pane.view_name.clone(),
        resume: pane.resume.clone(),
        agent_running,
        hibernated: keep_hibernated,
        keep_awake: pane.keep_awake,
        resume_failed: pane.resume_failed.clone(),
        locked: pane.locked,
        default_title: pane.default_title,
        title_pinned: pane.title_pinned,
        collapsed: pane.collapsed,
        ..SnapshotPane::new(&pane.id, &pane.title, snapshot_kind(pane.kind))
    }
}

fn from_split(split: &SplitNode, live: &HashSet<String>) -> SnapshotSplit {
    SnapshotSplit {
        id: split.id.clone(),
        direction: split.direction,
        children: split
            .children
            .iter()
            .map(|child| from_layout_node(child, live))
            .collect(),
        sizes: split.sizes.iter().copied().map(JsNumber).collect(),
        name: split.name.clone(),
        folded: split.folded,
    }
}

fn from_layout_node(node: &LayoutNode, live: &HashSet<String>) -> SnapshotNode {
    match node {
        LayoutNode::Pane(pane) => SnapshotNode::Pane(Box::new(from_pane(pane, live))),
        LayoutNode::Split(split) => SnapshotNode::Split(from_split(split, live)),
        LayoutNode::Tabs(tabs) => SnapshotNode::Tabs(SnapshotTabs {
            id: tabs.id.clone(),
            children: tabs
                .children
                .iter()
                .map(|child| match child {
                    TabNode::Pane(pane) => SnapshotTabItem::Pane(Box::new(from_pane(pane, live))),
                    TabNode::Split(split) => SnapshotTabItem::Split(from_split(split, live)),
                })
                .collect(),
            active_id: tabs.active_id.clone(),
        }),
    }
}

fn to_pane(node: &SnapshotPane) -> PaneNode {
    let mut pane = PaneNode::new(node.id.clone(), node.title.clone(), layout_kind(node.kind));
    pane.cwd = node.cwd.clone();
    pane.file_path = node.file_path.clone();
    pane.view_type = node.view_type.clone();
    pane.url = node.url.clone();
    pane.chat_session_id = node.chat_session_id.clone();
    pane.agent_session_id = node.agent_session_id.clone();
    pane.browser_profile = node.browser_profile.map(|_| BrowserProfile::Shared);
    pane.browser_device = node.browser_device.clone();
    pane.view_name = node.view_name.clone();
    pane.resume = node.resume.clone();
    pane.hibernated = node.hibernated;
    pane.keep_awake = node.keep_awake;
    pane.resume_failed = node.resume_failed.clone();
    pane.locked = node.locked;
    pane.default_title = node.default_title;
    pane.title_pinned = node.title_pinned;
    pane.collapsed = node.collapsed;
    if node.agent_running
        && let Some(resume) = &node.resume
    {
        pane.resume_pending = true;
        pane.spawn_dir = resume.resume.cwd.clone().filter(|cwd| !cwd.is_empty());
    }
    pane
}

fn persistable_root(root: &LayoutNode, work_dir: &str) -> LayoutNode {
    without_panes(root, &|pane| {
        pane.kind == SurfaceKind::Diff || is_remote_file_pane(pane)
    })
    .unwrap_or_else(|| {
        let mut pane = PaneNode::new(first_pane_id(root), TERMINAL_TITLE, SurfaceKind::Terminal);
        pane.cwd = Some(work_dir.to_owned());
        pane.default_title = true;
        pane.into()
    })
}

fn to_split(node: &SnapshotSplit) -> SplitNode {
    SplitNode {
        id: node.id.clone(),
        direction: node.direction,
        children: node.children.iter().map(to_layout_node).collect(),
        sizes: node.sizes.iter().map(|size| size.0).collect(),
        name: node.name.clone(),
        folded: node.folded,
    }
}

fn to_layout_node(node: &SnapshotNode) -> LayoutNode {
    match node {
        SnapshotNode::Pane(pane) => to_pane(pane).into(),
        SnapshotNode::Split(split) => to_split(split).into(),
        SnapshotNode::Tabs(tabs) => TabsNode {
            id: tabs.id.clone(),
            children: tabs
                .children
                .iter()
                .map(|child| match child {
                    SnapshotTabItem::Pane(pane) => to_pane(pane).into(),
                    SnapshotTabItem::Split(split) => to_split(split).into(),
                })
                .collect(),
            active_id: tabs.active_id.clone(),
        }
        .into(),
    }
}

fn filled(value: &Option<String>) -> Option<String> {
    value.clone().filter(|text| !text.is_empty())
}

fn snapshot_workspace(
    workspace: &RestorableWorkspace,
    layout: Option<&RestorableLayout>,
    live: &HashSet<String>,
) -> SnapshotWorkspace {
    let saved = layout.map(|layout| {
        let root = persistable_root(&layout.root, &workspace.work_dir);
        let active = if find_pane(&root, &layout.active_pane_id).is_some() {
            layout.active_pane_id.clone()
        } else {
            first_pane_id(&root).to_owned()
        };
        (from_layout_node(&root, live), active)
    });
    let (root, active_pane_id) = saved.unzip();
    SnapshotWorkspace {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        custom_name: filled(&workspace.custom_name),
        description: filled(&workspace.description),
        pinned: workspace.pinned,
        group_id: filled(&workspace.group_id),
        kind: workspace.kind,
        work_dir: workspace.work_dir.clone(),
        project_dir: filled(&workspace.project_dir),
        anchored: workspace.anchored,
        root,
        active_pane_id,
        origin: workspace.origin.clone(),
    }
}

pub fn workspace_handoff(
    workspace: &RestorableWorkspace,
    layout: Option<&RestorableLayout>,
    live_agent_panes: &HashSet<String>,
) -> SnapshotWorkspace {
    let ungrouped = RestorableWorkspace {
        group_id: None,
        ..workspace.clone()
    };
    snapshot_workspace(&ungrouped, layout, live_agent_panes)
}

pub struct SnapshotInput<'a> {
    pub workspaces: &'a [RestorableWorkspace],
    pub groups: &'a [SnapshotGroup],
    pub active_workspace_id: Option<&'a str>,
    pub layouts: &'a BTreeMap<String, RestorableLayout>,
    pub saved_at: &'a str,
    pub live_agent_panes: &'a HashSet<String>,
    pub left_panel: Option<LeftPanel>,
    pub right_panel: Option<&'a str>,
}

pub fn build_snapshot(input: &SnapshotInput<'_>) -> AppSnapshot {
    let workspaces: Vec<SnapshotWorkspace> = input
        .workspaces
        .iter()
        .map(|workspace| {
            snapshot_workspace(
                workspace,
                input.layouts.get(&workspace.id),
                input.live_agent_panes,
            )
        })
        .collect();
    let active_workspace_id = input
        .active_workspace_id
        .filter(|active| workspaces.iter().any(|workspace| workspace.id == *active))
        .map(str::to_owned)
        .or_else(|| workspaces.first().map(|workspace| workspace.id.clone()));
    let groups = input
        .groups
        .iter()
        .filter(|group| {
            workspaces
                .iter()
                .any(|workspace| workspace.group_id.as_deref() == Some(group.id.as_str()))
        })
        .cloned()
        .collect();
    AppSnapshot {
        v: 1,
        saved_at: input.saved_at.to_owned(),
        active_workspace_id,
        left_panel: input.left_panel,
        right_panel: input
            .right_panel
            .filter(|panel| !panel.is_empty())
            .map(str::to_owned),
        workspaces,
        groups,
        bounds: None,
        detached_bounds: None,
        windows: Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RestoredSnapshot {
    pub workspaces: Vec<RestorableWorkspace>,
    pub groups: Vec<SnapshotGroup>,
    pub active_workspace_id: Option<String>,
    pub layouts: BTreeMap<String, RestorableLayout>,
}

pub fn restore_snapshot(snapshot: &AppSnapshot, ids: &mut IdMint) -> RestoredSnapshot {
    let mut workspaces = Vec::with_capacity(snapshot.workspaces.len());
    let mut layouts = BTreeMap::new();
    for saved in &snapshot.workspaces {
        workspaces.push(RestorableWorkspace {
            id: saved.id.clone(),
            name: saved.name.clone(),
            custom_name: filled(&saved.custom_name),
            description: filled(&saved.description),
            pinned: saved.pinned,
            group_id: filled(&saved.group_id),
            kind: saved.kind,
            work_dir: saved.work_dir.clone(),
            project_dir: filled(&saved.project_dir),
            anchored: saved.anchored,
            origin: saved.origin.clone(),
        });
        let Some(node) = &saved.root else {
            continue;
        };
        let root = settle_collapse(&to_layout_node(node));
        adopt_ids(&root, ids);
        let active_pane_id = saved
            .active_pane_id
            .clone()
            .unwrap_or_else(|| first_pane_id(&root).to_owned());
        layouts.insert(
            saved.id.clone(),
            RestorableLayout {
                root,
                active_pane_id,
            },
        );
    }
    RestoredSnapshot {
        workspaces,
        groups: snapshot.groups.clone(),
        active_workspace_id: snapshot.active_workspace_id.clone(),
        layouts,
    }
}
