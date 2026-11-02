#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use ostia_base::js::JsNumber;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use ostia_model::ids::IdMint;
use ostia_model::layout::pane_fields::{set_default_pane_title, set_pane_resume, set_pane_view};
use ostia_model::layout::snapshot::{
    RestorableLayout, RestorableWorkspace, SnapshotInput, build_snapshot, restore_snapshot,
};
use ostia_model::layout::tree::{
    create_pane, set_split_tab_name, split_of, split_pane, tab_id_of, tabs_of,
};
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SurfaceKind, TabNode};
use ostia_workspaces::stored_resume::StoredResume;
use ostia_workspaces::workspace_snapshot::model::{
    AppSnapshot, LeftPanel, SnapshotGroup, SnapshotNode, SnapshotPane, SnapshotSplit,
    SnapshotWorkspace, SurfaceKind as SnapshotKind, WorkspaceKind,
};
use ostia_workspaces::workspace_text::WorkspaceGroupColor;

fn workspace(id: &str, name: &str, work_dir: &str) -> RestorableWorkspace {
    RestorableWorkspace {
        id: id.to_owned(),
        name: name.to_owned(),
        custom_name: None,
        description: None,
        pinned: false,
        group_id: None,
        kind: WorkspaceKind::Terminal,
        work_dir: work_dir.to_owned(),
        project_dir: None,
        anchored: false,
        origin: None,
    }
}

fn proj() -> RestorableWorkspace {
    workspace("s1", "proj", "/home/u/proj")
}

fn layouts_of(id: &str, root: &LayoutNode, active: &str) -> BTreeMap<String, RestorableLayout> {
    BTreeMap::from([(
        id.to_owned(),
        RestorableLayout {
            root: root.clone(),
            active_pane_id: active.to_owned(),
        },
    )])
}

fn input<'a>(
    workspaces: &'a [RestorableWorkspace],
    layouts: &'a BTreeMap<String, RestorableLayout>,
    groups: &'a [SnapshotGroup],
    live: &'a HashSet<String>,
    active: Option<&'a str>,
) -> SnapshotInput<'a> {
    SnapshotInput {
        workspaces,
        groups,
        active_workspace_id: active,
        layouts,
        saved_at: "2026-08-06T00:00:00.000Z",
        live_agent_panes: live,
        left_panel: None,
        right_panel: None,
    }
}

fn build_with(
    workspaces: &[RestorableWorkspace],
    root: &LayoutNode,
    active_pane: &str,
    live: &HashSet<String>,
) -> AppSnapshot {
    let layouts = layouts_of(&workspaces[0].id, root, active_pane);
    build_snapshot(&input(
        workspaces,
        &layouts,
        &[],
        live,
        Some(&workspaces[0].id),
    ))
}

fn build(root: &LayoutNode, active_pane: &str) -> AppSnapshot {
    build_with(&[proj()], root, active_pane, &HashSet::new())
}

fn terminal(ids: &mut IdMint) -> Arc<PaneNode> {
    Arc::new(create_pane(ids, SurfaceKind::Terminal, None, None))
}

fn pane_node(pane: &Arc<PaneNode>) -> LayoutNode {
    LayoutNode::Pane(pane.clone())
}

fn tab_node(pane: &Arc<PaneNode>) -> TabNode {
    TabNode::Pane(pane.clone())
}

fn split_node(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> LayoutNode {
    split_of(ids, direction, children).into()
}

fn collapsed(pane: &Arc<PaneNode>) -> LayoutNode {
    let mut next = (**pane).clone();
    next.collapsed = true;
    next.into()
}

fn saved_root(snapshot: &AppSnapshot) -> &SnapshotNode {
    snapshot.workspaces[0].root.as_ref().unwrap()
}

fn saved_pane(snapshot: &AppSnapshot) -> &SnapshotPane {
    match saved_root(snapshot) {
        SnapshotNode::Pane(pane) => pane.as_ref(),
        other => panic!("expected a pane, got {other:?}"),
    }
}

fn saved_split(node: &SnapshotNode) -> &SnapshotSplit {
    match node {
        SnapshotNode::Split(split) => split,
        other => panic!("expected a split, got {other:?}"),
    }
}

fn saved_child_pane(node: &SnapshotNode) -> &SnapshotPane {
    match node {
        SnapshotNode::Pane(pane) => pane.as_ref(),
        other => panic!("expected a pane, got {other:?}"),
    }
}

fn file_paths(node: &SnapshotNode) -> Vec<String> {
    match node {
        SnapshotNode::Pane(pane) => pane.file_path.iter().cloned().collect(),
        SnapshotNode::Split(split) => split.children.iter().flat_map(file_paths).collect(),
        SnapshotNode::Tabs(_) => Vec::new(),
    }
}

fn restored_root(snapshot: &AppSnapshot, ids: &mut IdMint, workspace_id: &str) -> LayoutNode {
    restore_snapshot(snapshot, ids).layouts[workspace_id]
        .root
        .clone()
}

fn restored_children(root: &LayoutNode) -> Vec<LayoutNode> {
    match root {
        LayoutNode::Split(split) => split.children.clone(),
        other => panic!("expected a split, got {other:?}"),
    }
}

fn restored_pane(node: &LayoutNode) -> Arc<PaneNode> {
    match node {
        LayoutNode::Pane(pane) => pane.clone(),
        other => panic!("expected a pane, got {other:?}"),
    }
}

fn resume_of(id: &str, cwd: Option<&str>) -> StoredResume {
    StoredResume {
        resume: AgentResume {
            agent: ResumableAgent::Claude,
            id: id.to_owned(),
            cwd: cwd.map(str::to_owned),
            args: Vec::new(),
            typed: None,
        },
        typed: None,
    }
}

fn agent_workspace() -> Vec<RestorableWorkspace> {
    vec![workspace("w1", "w", "/w")]
}

fn live_of(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn records_the_open_left_side_panel_and_omits_it_when_closed() {
    let mut ids = IdMint::default();
    let root = pane_node(&terminal(&mut ids));
    let workspaces = [proj()];
    let layouts = layouts_of("s1", &root, root.id());
    let live = HashSet::new();
    let mut with_input = input(&workspaces, &layouts, &[], &live, Some("s1"));
    with_input.left_panel = Some(LeftPanel::Files);
    assert_eq!(
        build_snapshot(&with_input).left_panel,
        Some(LeftPanel::Files)
    );
    with_input.left_panel = None;
    assert_eq!(build_snapshot(&with_input).left_panel, None);
}

#[test]
fn records_the_shown_right_side_panel_and_omits_it_when_none_is_shown() {
    let mut ids = IdMint::default();
    let root = pane_node(&terminal(&mut ids));
    let workspaces = [proj()];
    let layouts = layouts_of("s1", &root, root.id());
    let live = HashSet::new();
    let mut with_input = input(&workspaces, &layouts, &[], &live, Some("s1"));
    with_input.right_panel = Some("graphs");
    assert_eq!(
        build_snapshot(&with_input).right_panel,
        Some("graphs".to_owned())
    );
    with_input.right_panel = None;
    assert_eq!(build_snapshot(&with_input).right_panel, None);
}

#[test]
fn captures_each_workspace_with_its_tree_and_focused_pane() {
    let mut ids = IdMint::default();
    let pane = create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/home/u/proj"),
    );
    let root: LayoutNode = pane.into();
    let snapshot = build(&root, root.id());
    assert_eq!(snapshot.v, 1);
    assert_eq!(snapshot.saved_at, "2026-08-06T00:00:00.000Z");
    assert_eq!(snapshot.active_workspace_id, Some("s1".to_owned()));
    let saved = &snapshot.workspaces[0];
    assert_eq!(saved.id, "s1");
    assert_eq!(saved.name, "proj");
    assert_eq!(saved.kind, WorkspaceKind::Terminal);
    assert_eq!(saved.work_dir, "/home/u/proj");
    assert_eq!(saved.active_pane_id, Some(root.id().to_owned()));
    let pane = saved_pane(&snapshot);
    assert_eq!(pane.id, root.id());
    assert_eq!(pane.kind, SnapshotKind::Terminal);
    assert_eq!(pane.cwd, Some("/home/u/proj".to_owned()));
}

#[test]
fn carries_a_splits_direction_sizes_and_children() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&a), pane_node(&b)],
    );
    let snapshot = build(&root, &a.id);
    let split = saved_split(saved_root(&snapshot));
    assert_eq!(split.direction, Direction::Vertical);
    assert_eq!(split.sizes, vec![JsNumber(1.0), JsNumber(1.0)]);
    let child_ids: Vec<String> = split
        .children
        .iter()
        .map(|child| saved_child_pane(child).id.clone())
        .collect();
    assert_eq!(child_ids, vec![a.id.clone(), b.id.clone()]);
}

#[test]
fn round_trips_a_named_split_tab_and_the_pane_shown_in_it() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let stack: LayoutNode = tabs_of(&mut ids, &b.id, vec![tab_node(&a), tab_node(&b)]).into();
    let stacked = split_pane(&mut ids, &stack, &b.id, Direction::Vertical, (*c).clone()).root;
    let tab_id = tab_id_of(&stacked, &c.id).unwrap_or_default();
    let root = set_split_tab_name(&stacked, &tab_id, Some("api"));
    let snapshot = build(&root, &c.id);
    let restored = restore_snapshot(&snapshot, &mut ids);
    assert_eq!(restored.layouts["s1"].root, root);
    assert_eq!(restored.layouts["s1"].active_pane_id, c.id);
}

#[test]
fn round_trips_a_collapsed_pane_of_a_split_tab_and_expands_one_no_tab_holds_any_more() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let tab = split_of(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&b), collapsed(&c)],
    );
    let root: LayoutNode = tabs_of(&mut ids, &b.id, vec![tab_node(&a), TabNode::from(tab)]).into();
    assert_eq!(restored_root(&build(&root, &b.id), &mut ids, "s1"), root);
    let loose = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), collapsed(&c)],
    );
    let restored = restored_root(&build(&loose, &a.id), &mut ids, "s1");
    let second = restored_pane(&restored_children(&restored)[1]);
    assert!(!second.collapsed);
}

#[test]
fn round_trips_a_folded_split_tab_that_is_not_shown() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let mut tab = split_of(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&b), pane_node(&c)],
    );
    tab.folded = true;
    let root: LayoutNode = tabs_of(&mut ids, &a.id, vec![tab_node(&a), TabNode::from(tab)]).into();
    assert_eq!(restored_root(&build(&root, &a.id), &mut ids, "s1"), root);
}

#[test]
fn carries_an_editors_file_path_and_a_browsers_url() {
    let mut ids = IdMint::default();
    let mut editor = PaneNode::new("pane-1", "a.ts", SurfaceKind::Editor);
    editor.file_path = Some("/p/a.ts".to_owned());
    let mut browser = PaneNode::new("pane-2", "x", SurfaceKind::Browser);
    browser.url = Some("http://x/".to_owned());
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![editor.into(), browser.into()],
    );
    let snapshot = build(&root, "pane-1");
    let split = saved_split(saved_root(&snapshot));
    let expected_editor = SnapshotPane {
        file_path: Some("/p/a.ts".to_owned()),
        ..SnapshotPane::new("pane-1", "a.ts", SnapshotKind::Editor)
    };
    let expected_browser = SnapshotPane {
        url: Some("http://x/".to_owned()),
        ..SnapshotPane::new("pane-2", "x", SnapshotKind::Browser)
    };
    assert_eq!(
        split.children,
        vec![
            SnapshotNode::Pane(Box::new(expected_editor)),
            SnapshotNode::Pane(Box::new(expected_browser)),
        ]
    );
}

#[test]
fn saves_a_workspace_that_has_no_layout_as_an_empty_workspace() {
    let mut ids = IdMint::default();
    let root = pane_node(&terminal(&mut ids));
    let workspaces = [proj(), workspace("s2", "x", "/tmp")];
    let layouts = layouts_of("s1", &root, root.id());
    let live = HashSet::new();
    let mut with_input = input(&workspaces, &layouts, &[], &live, Some("s2"));
    with_input.saved_at = "";
    let snapshot = build_snapshot(&with_input);
    assert_eq!(
        snapshot.workspaces[1],
        SnapshotWorkspace {
            id: "s2".to_owned(),
            name: "x".to_owned(),
            custom_name: None,
            description: None,
            pinned: false,
            group_id: None,
            kind: WorkspaceKind::Terminal,
            work_dir: "/tmp".to_owned(),
            project_dir: None,
            anchored: false,
            root: None,
            active_pane_id: None,
            origin: None,
        }
    );
    assert_eq!(snapshot.active_workspace_id, Some("s2".to_owned()));
    assert!(
        !restore_snapshot(&snapshot, &mut ids)
            .layouts
            .contains_key("s2")
    );
}

#[test]
fn saves_and_restores_a_workspace_description_and_pin() {
    let mut ids = IdMint::default();
    let described = RestorableWorkspace {
        description: Some("PR #7".to_owned()),
        pinned: true,
        ..proj()
    };
    let workspaces = [described];
    let layouts = BTreeMap::new();
    let live = HashSet::new();
    let mut with_input = input(&workspaces, &layouts, &[], &live, Some("s1"));
    with_input.saved_at = "";
    let snapshot = build_snapshot(&with_input);
    let restored = restore_snapshot(&snapshot, &mut ids);
    assert_eq!(restored.workspaces[0].description, Some("PR #7".to_owned()));
    assert!(restored.workspaces[0].pinned);
}

#[test]
fn round_trips_groups_and_memberships_and_leaves_out_a_group_with_no_members() {
    let mut ids = IdMint::default();
    let workspaces = [
        RestorableWorkspace {
            group_id: Some("g1".to_owned()),
            ..proj()
        },
        workspace("s2", "x", "/tmp"),
    ];
    let groups = [
        SnapshotGroup {
            id: "g1".to_owned(),
            name: "api".to_owned(),
            color: Some(WorkspaceGroupColor::Green),
            collapsed: true,
        },
        SnapshotGroup {
            id: "g2".to_owned(),
            name: "empty".to_owned(),
            color: None,
            collapsed: false,
        },
    ];
    let layouts = BTreeMap::new();
    let live = HashSet::new();
    let mut with_input = input(&workspaces, &layouts, &groups, &live, Some("s1"));
    with_input.saved_at = "";
    let snapshot = build_snapshot(&with_input);
    assert_eq!(snapshot.groups, vec![groups[0].clone()]);
    let restored = restore_snapshot(&snapshot, &mut ids);
    assert_eq!(restored.groups, snapshot.groups);
    let memberships: Vec<Option<String>> = restored
        .workspaces
        .iter()
        .map(|workspace| workspace.group_id.clone())
        .collect();
    assert_eq!(memberships, vec![Some("g1".to_owned()), None]);
}

#[test]
fn saves_and_restores_a_name_the_user_gave_a_workspace() {
    let mut ids = IdMint::default();
    let named = RestorableWorkspace {
        custom_name: Some("payments".to_owned()),
        ..proj()
    };
    let workspaces = [named];
    let layouts = BTreeMap::new();
    let live = HashSet::new();
    let snapshot = build_snapshot(&input(&workspaces, &layouts, &[], &live, Some("s1")));
    assert_eq!(
        restore_snapshot(&snapshot, &mut ids).workspaces[0].custom_name,
        Some("payments".to_owned())
    );
}

#[test]
fn drops_diff_panes_which_hold_live_in_memory_content_and_refocuses_a_survivor() {
    let mut ids = IdMint::default();
    let term = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/home/u/proj"),
    ));
    let diff = PaneNode::new("pane-9", "a.ts", SurfaceKind::Diff);
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&term), diff.into()],
    );
    let snapshot = build(&root, "pane-9");
    let pane = saved_pane(&snapshot);
    assert_eq!(pane.id, term.id);
    assert_eq!(pane.kind, SnapshotKind::Terminal);
    assert_eq!(snapshot.workspaces[0].active_pane_id, Some(term.id.clone()));
}

#[test]
fn ssh_c64_drops_a_remote_file_pane_which_lives_only_while_its_folder_is_open() {
    let mut ids = IdMint::default();
    let term = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/home/u/proj"),
    ));
    let mut remote = PaneNode::new("pane-9", "app.conf", SurfaceKind::Editor);
    remote.file_path = Some("remote://abcdef012345/srv/app/app.conf".to_owned());
    let mut local = PaneNode::new("pane-8", "a.ts", SurfaceKind::Editor);
    local.file_path = Some("/home/u/proj/a.ts".to_owned());
    let inner = split_node(
        &mut ids,
        Direction::Vertical,
        vec![remote.into(), local.into()],
    );
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&term), inner],
    );
    let snapshot = build(&root, "pane-9");
    let paths = file_paths(saved_root(&snapshot));
    assert!(paths.iter().all(|path| !path.contains("remote://")));
    assert!(paths.contains(&"/home/u/proj/a.ts".to_owned()));
    assert_eq!(snapshot.workspaces[0].active_pane_id, Some(term.id.clone()));
}

#[test]
fn replaces_a_lone_diff_pane_with_a_terminal_at_the_workspace_work_dir() {
    let diff: LayoutNode = PaneNode::new("pane-4", "a.ts", SurfaceKind::Diff).into();
    let snapshot = build(&diff, diff.id());
    let expected = SnapshotPane {
        cwd: Some("/home/u/proj".to_owned()),
        default_title: true,
        ..SnapshotPane::new("pane-4", "Terminal", SnapshotKind::Terminal)
    };
    assert_eq!(
        saved_root(&snapshot),
        &SnapshotNode::Pane(Box::new(expected))
    );
}

#[test]
fn builds_an_empty_workspace_with_no_active_workspace_when_there_are_no_workspaces() {
    let layouts = BTreeMap::new();
    let live = HashSet::new();
    let mut with_input = input(&[], &layouts, &[], &live, None);
    with_input.saved_at = "t";
    assert_eq!(
        build_snapshot(&with_input),
        AppSnapshot {
            v: 1,
            saved_at: "t".to_owned(),
            active_workspace_id: None,
            workspaces: Vec::new(),
            groups: Vec::new(),
            left_panel: None,
            right_panel: None,
            bounds: None,
            detached_bounds: None,
            windows: Vec::new(),
        }
    );
}

#[test]
fn round_trips_a_workspace_built_from_live_state() {
    let mut ids = IdMint::default();
    let a = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/home/u/proj"),
    ));
    let b = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Editor,
        Some("a.ts"),
        None,
    ));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let snapshot = build(&root, &b.id);
    let restored = restore_snapshot(&snapshot, &mut ids);
    assert_eq!(restored.workspaces, vec![proj()]);
    assert_eq!(restored.active_workspace_id, Some("s1".to_owned()));
    assert_eq!(restored.layouts["s1"].root, root);
    assert_eq!(restored.layouts["s1"].active_pane_id, b.id);
}

#[test]
fn keeps_the_default_title_mark_of_an_untouched_terminal_and_never_gives_one_to_a_named_tab() {
    let mut ids = IdMint::default();
    let fresh = terminal(&mut ids);
    let untouched = set_default_pane_title(&pane_node(&fresh), &fresh.id, "bash");
    let named = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("pnpm dev"),
        None,
    ));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![untouched, pane_node(&named)],
    );
    let restored = restored_root(&build(&root, &fresh.id), &mut ids, "s1");
    let children = restored_children(&restored);
    let first = restored_pane(&children[0]);
    let second = restored_pane(&children[1]);
    assert_eq!(first.title, "bash");
    assert!(first.default_title);
    assert_eq!(second.title, "pnpm dev");
    assert!(!second.default_title);
}

#[test]
fn reserves_the_restored_ids_so_a_newly_created_pane_cannot_collide() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let snapshot = build(&root, &a.id);
    let mut fresh = IdMint::default();
    restore_snapshot(&snapshot, &mut fresh);
    let created = create_pane(&mut fresh, SurfaceKind::Terminal, None, None);
    assert_eq!(created.id, "pane-4");
}

#[test]
fn round_trips_a_view_pane_next_to_a_pending_agent_resume() {
    let mut ids = IdMint::default();
    let mut agent = create_pane(&mut ids, SurfaceKind::Terminal, Some("claude"), None);
    agent.resume = Some(resume_of("abc-1", None));
    agent.resume_pending = true;
    let agent = Arc::new(agent);
    let loose = terminal(&mut ids);
    let view = set_pane_view(&pane_node(&loose), "pane-2", "board", "Board");
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&agent), view],
    );
    let snapshot = build(&root, &agent.id);
    let saved = saved_split(saved_root(&snapshot));
    let expected_view = SnapshotPane {
        view_name: Some("board".to_owned()),
        ..SnapshotPane::new("pane-2", "Board", SnapshotKind::View)
    };
    assert_eq!(
        saved.children[1],
        SnapshotNode::Pane(Box::new(expected_view))
    );
    assert!(saved_child_pane(&saved.children[0]).agent_running);
    assert_eq!(restored_root(&snapshot, &mut ids, "s1"), root);
}

#[test]
fn marks_a_pane_whose_agent_is_running_and_restores_it_as_pending_a_resume() {
    let mut ids = IdMint::default();
    let mut agent = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    agent.resume = Some(resume_of("abc-1", None));
    let agent = Arc::new(agent);
    let mut idle = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    idle.resume = Some(resume_of("old-2", None));
    let idle = Arc::new(idle);
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&agent), pane_node(&idle)],
    );
    let snapshot = build_with(
        &agent_workspace(),
        &root,
        &agent.id,
        &live_of(&[agent.id.as_str()]),
    );
    let restored = restored_root(&snapshot, &mut ids, "w1");
    let children = restored_children(&restored);
    let restored_agent = children
        .iter()
        .map(restored_pane)
        .find(|pane| pane.id == agent.id)
        .unwrap();
    let restored_idle = children
        .iter()
        .map(restored_pane)
        .find(|pane| pane.id == idle.id)
        .unwrap();
    assert!(restored_agent.resume_pending);
    assert!(!restored_idle.resume_pending);
}

#[test]
fn restores_a_running_agents_pane_to_start_its_shell_in_the_agents_folder_never_saving_that_mark() {
    let mut ids = IdMint::default();
    let mut agent = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    agent.cwd = Some("/w".to_owned());
    agent.resume = Some(resume_of("abc-1", Some("/w/tree")));
    agent.spawn_dir = Some("/w/tree".to_owned());
    agent.resume_folder_missing = Some("/w/old".to_owned());
    let root: LayoutNode = agent.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &live_of(&[root.id()]));
    let restored = restored_pane(&restored_root(&snapshot, &mut ids, "w1"));
    assert_eq!(restored.cwd, Some("/w".to_owned()));
    assert!(restored.resume_pending);
    assert_eq!(restored.spawn_dir, Some("/w/tree".to_owned()));
    assert_eq!(restored.resume_folder_missing, None);
}

#[test]
fn restores_a_running_agents_pane_in_the_folder_its_session_moved_to() {
    let mut ids = IdMint::default();
    let mut agent = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    agent.cwd = Some("/w".to_owned());
    agent.resume = Some(resume_of("abc-1", Some("/w/tree")));
    let agent_id = agent.id.clone();
    let moved = set_pane_resume(
        &agent.into(),
        &agent_id,
        &resume_of("abc-1", Some("/w/tree/wt1")),
    );
    let snapshot = build_with(
        &agent_workspace(),
        &moved,
        &agent_id,
        &live_of(&[agent_id.as_str()]),
    );
    let restored = restored_pane(&restored_root(&snapshot, &mut ids, "w1"));
    assert_eq!(
        restored.resume.as_ref().unwrap().resume.cwd,
        Some("/w/tree/wt1".to_owned())
    );
    assert!(restored.resume_pending);
    assert_eq!(restored.spawn_dir, Some("/w/tree/wt1".to_owned()));
}

#[test]
fn saves_and_restores_a_locked_pane_as_locked() {
    let mut ids = IdMint::default();
    let mut kept = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    kept.locked = true;
    let root: LayoutNode = kept.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &HashSet::new());
    assert!(saved_pane(&snapshot).locked);
    let restored = restored_pane(&restored_root(&snapshot, &mut ids, "w1"));
    assert_eq!(restored.id, root.id());
    assert!(restored.locked);
}

#[test]
fn saves_a_hibernated_agent_pane_as_hibernated_not_as_an_agent_to_resume() {
    let mut ids = IdMint::default();
    let mut asleep = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    asleep.resume = Some(resume_of("abc-1", None));
    asleep.hibernated = true;
    let root: LayoutNode = asleep.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &live_of(&[root.id()]));
    assert!(saved_pane(&snapshot).hibernated);
    assert!(!saved_pane(&snapshot).agent_running);
    let restored = restored_pane(&restored_root(&snapshot, &mut ids, "w1"));
    assert_eq!(restored.id, root.id());
    assert!(restored.hibernated);
    assert!(!restored.resume_pending);
}

#[test]
fn keeps_a_kept_awake_mark_through_a_save_and_a_restore() {
    let mut ids = IdMint::default();
    let mut kept = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    kept.resume = Some(resume_of("abc-1", None));
    kept.keep_awake = true;
    let root: LayoutNode = kept.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &live_of(&[root.id()]));
    assert!(saved_pane(&snapshot).keep_awake);
    let restored = restored_pane(&restored_root(&snapshot, &mut ids, "w1"));
    assert_eq!(restored.id, root.id());
    assert!(restored.keep_awake);
}

#[test]
fn drops_the_hibernated_mark_of_a_pane_that_has_nothing_to_resume() {
    let mut ids = IdMint::default();
    let mut plain = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    plain.hibernated = true;
    let root: LayoutNode = plain.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &HashSet::new());
    assert!(!saved_pane(&snapshot).hibernated);
}

#[test]
fn keeps_a_pending_resume_through_another_save_until_it_happens() {
    let mut ids = IdMint::default();
    let mut pending = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    pending.resume = Some(resume_of("abc-1", None));
    pending.resume_pending = true;
    let root: LayoutNode = pending.into();
    let snapshot = build_with(&agent_workspace(), &root, root.id(), &HashSet::new());
    assert!(saved_pane(&snapshot).agent_running);
}
