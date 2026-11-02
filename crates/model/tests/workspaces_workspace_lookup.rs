#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::stores::app::settings_model::NewWorkspacePlacement;
use ostia_model::workspaces::workspaces_store::{WorkspaceKind, WorkspacesStore};

fn add(store: &mut WorkspacesStore, work_dir: &str) -> String {
    store.add_workspace(
        work_dir,
        NewWorkspacePlacement::End,
        WorkspaceKind::Terminal,
    )
}

#[test]
fn finds_no_workspace_in_an_empty_store() {
    let store = WorkspacesStore::default();
    assert!(store.workspace("workspace-1").is_none());
    assert_eq!(store.work_dir_of("workspace-1"), None);
}

#[test]
fn finds_the_workspace_and_its_work_dir_by_id() {
    let mut store = WorkspacesStore::default();
    let a = add(&mut store, "/a");
    let b = add(&mut store, "/b");
    assert_eq!(store.workspace(&a).expect("a").work_dir, "/a");
    assert_eq!(store.workspace(&b).expect("b").work_dir, "/b");
    assert_eq!(store.work_dir_of(&a), Some("/a"));
    assert_eq!(store.work_dir_of(&b), Some("/b"));
}

#[test]
fn finds_nothing_for_an_unknown_id() {
    let mut store = WorkspacesStore::default();
    add(&mut store, "/a");
    assert!(store.workspace("nope").is_none());
    assert_eq!(store.work_dir_of("nope"), None);
    assert_eq!(store.work_dir_of(""), None);
}

#[test]
fn follows_a_work_dir_change() {
    let mut store = WorkspacesStore::default();
    let id = add(&mut store, "/a");
    store.set_work_dir(&id, "/moved");
    assert_eq!(store.work_dir_of(&id), Some("/moved"));
}

#[test]
fn finds_nothing_after_the_workspace_is_removed() {
    let mut store = WorkspacesStore::default();
    let id = add(&mut store, "/a");
    store.remove(&id);
    assert!(store.workspace(&id).is_none());
    assert_eq!(store.work_dir_of(&id), None);
}
