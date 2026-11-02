#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::WorkspaceLiveState;
use ostia_model::ids::IdNamespace;
use ostia_model::stores::app::settings_model::NewWorkspacePlacement;
use ostia_model::workspaces::actions::{close_workspace, ensure_terminal, new_tab_or_terminal};
use ostia_model::workspaces::layout_store::LayoutStore;
use ostia_model::workspaces::workspaces_store::{
    WorkspaceKind, WorkspacesStore, name_from_work_dir, workspace_title,
};

fn add(store: &mut WorkspacesStore, work_dir: &str) -> String {
    store.add_workspace(
        work_dir,
        NewWorkspacePlacement::End,
        WorkspaceKind::Terminal,
    )
}

fn order(store: &WorkspacesStore) -> Vec<&str> {
    store
        .workspaces()
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect()
}

#[test]
fn starts_with_no_workspaces_and_no_active_workspace() {
    let store = WorkspacesStore::default();
    assert!(store.workspaces().is_empty());
    assert_eq!(store.active_workspace_id(), None);
}

#[test]
fn add_workspace_appends_a_focused_empty_workspace_named_from_its_work_dir() {
    let mut store = WorkspacesStore::default();
    let id = add(&mut store, "/foo/bar");
    assert_eq!(store.active_workspace_id(), Some(id.as_str()));
    let workspace = store.workspace(&id).expect("workspace");
    assert_eq!(workspace.name, "bar");
    assert_eq!(workspace.work_dir, "/foo/bar");
    assert_eq!(workspace.state, WorkspaceLiveState::Idle);
}

#[test]
fn add_workspace_inserts_at_the_top_after_the_current_one_or_at_the_end_per_placement() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    store.set_active(&a);
    let after = store.add_workspace(
        "/c",
        NewWorkspacePlacement::AfterCurrent,
        WorkspaceKind::Terminal,
    );
    let top = store.add_workspace("/d", NewWorkspacePlacement::Top, WorkspaceKind::Terminal);
    assert_eq!(
        order(&store),
        vec![top.as_str(), a.as_str(), after.as_str(), b.as_str()]
    );
}

#[test]
fn add_workspace_defaults_work_dir_to_home_name() {
    assert_eq!(name_from_work_dir("~"), "home");
    assert_eq!(name_from_work_dir(""), "home");
}

#[test]
fn ids_use_the_namespace_of_the_window() {
    let mut store = WorkspacesStore::new(IdNamespace::new("win2"));
    assert_eq!(add(&mut store, "/a"), "wwin2-1");
}

#[test]
fn set_active_sets_active_workspace_id_to_the_given_id() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    add(&mut store, "/b");
    assert!(store.set_active(&a));
    assert_eq!(store.active_workspace_id(), Some(a.as_str()));
    assert!(!store.set_active(&a));
}

#[test]
fn set_work_dir_re_anchors_the_workspace_and_re_derives_its_name() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    assert!(store.set_work_dir(&a, "/new/place"));
    assert_eq!(store.workspace(&a).expect("a").name, "place");
    assert_eq!(store.workspace(&b).expect("b").work_dir, "/b");
}

#[test]
fn close_workspace_keeps_a_workspace_that_holds_a_locked_pane() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let id = add(&mut store, "/a");
    let pane = ensure_terminal(&store, &mut layouts, &id).expect("pane");
    layouts.set_locked(&id, &pane, true);
    assert!(!close_workspace(&mut store, &mut layouts, &id));
    assert!(store.workspace(&id).is_some());
    assert!(layouts.layout(&id).is_some());
}

#[test]
fn close_workspace_removes_a_non_active_workspace_leaves_the_active_one_and_drops_its_layout() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    ensure_terminal(&store, &mut layouts, &a);
    let b = add(&mut store, "/b");
    assert!(close_workspace(&mut store, &mut layouts, &a));
    assert_eq!(store.active_workspace_id(), Some(b.as_str()));
    assert!(layouts.layout(&a).is_none());
}

#[test]
fn close_workspace_falls_to_the_right_neighbour_when_the_active_leftmost_workspace_closes() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    store.set_active(&a);
    close_workspace(&mut store, &mut layouts, &a);
    assert_eq!(store.active_workspace_id(), Some(b.as_str()));
}

#[test]
fn close_workspace_falls_to_the_left_neighbour_when_the_active_workspace_closes() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    add(&mut store, "/c");
    store.set_active(&b);
    close_workspace(&mut store, &mut layouts, &b);
    assert_eq!(store.active_workspace_id(), Some(a.as_str()));
}

#[test]
fn close_workspace_leaves_zero_workspaces_and_no_active_workspace_when_the_last_one_closes() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    close_workspace(&mut store, &mut layouts, &a);
    assert!(store.workspaces().is_empty());
    assert_eq!(store.active_workspace_id(), None);
}

#[test]
fn close_workspace_mints_a_fresh_id_for_a_workspace_opened_after_the_last_one_closed() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    close_workspace(&mut store, &mut layouts, &a);
    assert_ne!(add(&mut store, "/b"), a);
}

#[test]
fn set_state_updates_the_target_workspace_and_touches_only_it() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    assert!(store.set_state(&a, WorkspaceLiveState::Working));
    assert_eq!(
        store.workspace(&a).expect("a").state,
        WorkspaceLiveState::Working
    );
    assert_eq!(
        store.workspace(&b).expect("b").state,
        WorkspaceLiveState::Idle
    );
}

#[test]
fn set_state_is_a_no_op_when_the_workspace_is_already_in_that_state() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    assert!(!store.set_state(&a, WorkspaceLiveState::Idle));
}

#[test]
fn set_state_is_a_no_op_for_an_unknown_workspace_id() {
    let mut store = WorkspacesStore::default();
    assert!(!store.set_state("nope", WorkspaceLiveState::Working));
}

#[test]
fn name_from_work_dir_strips_a_trailing_slash() {
    assert_eq!(name_from_work_dir("/foo/bar/"), "bar");
}

#[test]
fn name_from_work_dir_falls_back_to_workspace_for_a_root_path() {
    assert_eq!(name_from_work_dir("/"), "workspace");
}

#[test]
fn rename_shows_a_name_the_user_chose_and_clears_it_with_an_empty_name() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    store.rename(&a, " mine ");
    assert_eq!(workspace_title(store.workspace(&a).expect("a")), "mine");
    store.rename(&a, "  ");
    assert_eq!(workspace_title(store.workspace(&a).expect("a")), "a");
}

#[test]
fn new_tab_or_terminal_seeds_an_empty_workspace_then_adds_a_tab_from_its_work_dir() {
    let mut store = WorkspacesStore::default();
    let mut layouts = LayoutStore::default();
    let a = add(&mut store, "/a");
    let first = new_tab_or_terminal(&store, &mut layouts).expect("first pane");
    let second = new_tab_or_terminal(&store, &mut layouts).expect("second pane");
    assert_ne!(first, second);
    assert_eq!(layouts.layout(&a).expect("layout").active_pane_id, second);
}
