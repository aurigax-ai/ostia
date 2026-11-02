#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::ids::IdNamespace;
use ostia_model::layout::tree::{
    TERMINAL_TITLE, find_pane, first_pane_id, pane_ids, tab_index, tabs_of_pane,
};
use ostia_model::layout::types::{Direction, LayoutNode};
use ostia_model::workspaces::layout_store::LayoutStore;

fn root_of(store: &LayoutStore, workspace: &str) -> LayoutNode {
    store.layout(workspace).expect("layout").root.clone()
}

fn active_of(store: &LayoutStore, workspace: &str) -> String {
    store
        .layout(workspace)
        .expect("layout")
        .active_pane_id
        .clone()
}

fn tabs(store: &mut LayoutStore, workspace: &str, count: usize) -> Vec<String> {
    store.ensure(workspace, None);
    let mut ids = vec![first_pane_id(&root_of(store, workspace)).to_owned()];
    for at in 1..count {
        let previous = ids[at - 1].clone();
        ids.push(
            store
                .new_terminal_tab(workspace, &previous, None)
                .expect("tab"),
        );
    }
    ids
}

fn shown(store: &LayoutStore, workspace: &str, id: &str) -> Option<String> {
    tabs_of_pane(&root_of(store, workspace), id).map(|stack| stack.active_id.clone())
}

#[test]
fn starts_with_an_empty_by_workspace() {
    let store = LayoutStore::default();
    assert_eq!(store.workspace_ids().count(), 0);
}

#[test]
fn ensure_creates_a_one_terminal_pane_layout() {
    let mut store = LayoutStore::default();
    let created = store.ensure("w1", Some("/work")).expect("pane");
    let root = root_of(&store, "w1");
    let pane = find_pane(&root, &created).expect("pane in tree");
    assert_eq!(pane.cwd.as_deref(), Some("/work"));
    assert_eq!(active_of(&store, "w1"), created);
}

#[test]
fn ensure_is_a_no_op_on_a_second_call() {
    let mut store = LayoutStore::default();
    store.ensure("w1", None);
    let before = root_of(&store, "w1");
    assert!(store.ensure("w1", None).is_none());
    assert!(root_of(&store, "w1").is_same(&before));
}

#[test]
fn default_terminal_title_gives_every_new_terminal_the_neutral_word_and_marks_it_untouched() {
    let mut store = LayoutStore::default();
    let created = store.ensure("w1", None).expect("pane");
    let pane = find_pane(&root_of(&store, "w1"), &created).expect("pane");
    assert_eq!(pane.title, TERMINAL_TITLE);
    assert!(pane.default_title);
}

#[test]
fn default_terminal_title_names_an_untouched_tab_after_its_shell() {
    let mut store = LayoutStore::default();
    let created = store.ensure("w1", None).expect("pane");
    assert!(store.set_title("w1", &created, "vim"));
    let pane = find_pane(&root_of(&store, "w1"), &created).expect("pane");
    assert_eq!(pane.title, "vim");
    assert!(!pane.default_title);
    assert!(!store.set_title("w1", &created, "vim"));
}

#[test]
fn ids_use_the_namespace_of_the_window() {
    let mut store = LayoutStore::new(IdNamespace::new("win2"));
    assert_eq!(store.ensure("w1", None).as_deref(), Some("pane-win2-1"));
}

#[test]
fn split_adds_a_pane_and_focuses_the_new_pane() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    let created = store
        .split("w1", &first, Direction::Horizontal, Some("/work"))
        .expect("new pane");
    let root = root_of(&store, "w1");
    assert_eq!(pane_ids(&root), vec![first, created.clone()]);
    assert_eq!(active_of(&store, "w1"), created);
    assert_eq!(
        find_pane(&root, &created)
            .and_then(|pane| pane.cwd.clone())
            .as_deref(),
        Some("/work")
    );
}

#[test]
fn split_is_a_no_op_on_an_absent_workspace() {
    let mut store = LayoutStore::default();
    assert!(
        store
            .split("nope", "p", Direction::Horizontal, None)
            .is_none()
    );
    assert!(store.layout("nope").is_none());
}

#[test]
fn split_on_an_existing_workspace_with_a_missing_target_pane_adds_no_pane() {
    let mut store = LayoutStore::default();
    store.ensure("w1", None);
    let before = root_of(&store, "w1");
    assert!(
        store
            .split("w1", "nope", Direction::Horizontal, None)
            .is_none()
    );
    assert!(root_of(&store, "w1").is_same(&before));
}

#[test]
fn locked_panes_keeps_a_locked_pane_through_close_pane_and_closes_it_once_unlocked() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    let second = store
        .split("w1", &first, Direction::Horizontal, None)
        .expect("pane");
    assert!(store.set_locked("w1", &second, true));
    assert!(!store.close_pane("w1", &second));
    assert!(find_pane(&root_of(&store, "w1"), &second).is_some());
    assert!(store.set_locked("w1", &second, false));
    assert!(store.close_pane("w1", &second));
    assert!(find_pane(&root_of(&store, "w1"), &second).is_none());
}

#[test]
fn locked_panes_keeps_the_only_pane_of_a_workspace_when_it_is_locked() {
    let mut store = LayoutStore::default();
    let only = store.ensure("w1", None).expect("pane");
    store.set_locked("w1", &only, true);
    assert!(!store.close_pane("w1", &only));
    assert!(store.layout("w1").is_some());
}

#[test]
fn close_pane_removes_a_real_pane_in_a_2_pane_layout_and_moves_focus() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    let second = store
        .split("w1", &first, Direction::Horizontal, None)
        .expect("pane");
    assert!(store.close_pane("w1", &second));
    assert_eq!(active_of(&store, "w1"), first);
}

#[test]
fn closing_the_last_pane_leaves_the_workspace_empty() {
    let mut store = LayoutStore::default();
    let only = store.ensure("w1", None).expect("pane");
    assert!(store.close_pane("w1", &only));
    assert!(store.layout("w1").is_none());
}

#[test]
fn close_pane_reports_nothing_for_an_id_that_never_existed_or_was_already_closed() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    let second = store
        .split("w1", &first, Direction::Horizontal, None)
        .expect("pane");
    assert!(!store.close_pane("w1", "nope"));
    assert!(store.close_pane("w1", &second));
    assert!(!store.close_pane("w1", &second));
}

#[test]
fn close_pane_is_a_no_op_on_an_absent_workspace() {
    let mut store = LayoutStore::default();
    assert!(!store.close_pane("nope", "p"));
}

#[test]
fn focus_pane_sets_active_pane_id() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    store.split("w1", &first, Direction::Horizontal, None);
    assert!(store.focus_pane("w1", &first));
    assert_eq!(active_of(&store, "w1"), first);
    assert!(!store.focus_pane("w1", &first));
}

#[test]
fn resize_updates_the_sizes_of_the_target_split() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    store.split("w1", &first, Direction::Horizontal, None);
    let LayoutNode::Split(split) = root_of(&store, "w1") else {
        panic!("expected a split");
    };
    assert!(store.resize("w1", &split.id, &[3.0, 1.0]));
    let LayoutNode::Split(resized) = root_of(&store, "w1") else {
        panic!("expected a split");
    };
    assert_eq!(resized.sizes, vec![3.0, 1.0]);
    assert!(!store.resize("w1", &split.id, &[3.0, 1.0]));
}

#[test]
fn set_cwd_updates_the_target_pane_and_leaves_the_root_identical_when_unchanged() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    assert!(store.set_cwd("w1", &first, "/x"));
    let before = root_of(&store, "w1");
    assert!(!store.set_cwd("w1", &first, "/x"));
    assert!(root_of(&store, "w1").is_same(&before));
}

#[test]
fn equalize_on_split_makes_every_size_equal_and_counts_it() {
    let mut store = LayoutStore::default();
    store.set_equalize_on_split(true);
    let first = store.ensure("w1", None).expect("pane");
    let second = store
        .split("w1", &first, Direction::Horizontal, None)
        .expect("pane");
    store.split("w1", &second, Direction::Horizontal, None);
    let LayoutNode::Split(split) = root_of(&store, "w1") else {
        panic!("expected a split");
    };
    assert_eq!(split.sizes, vec![1.0, 1.0, 1.0]);
    assert_eq!(store.layout("w1").expect("layout").equalized, Some(2));
}

#[test]
fn close_focus_returns_to_the_tab_that_opened_the_closed_one_past_a_tab_in_between() {
    let mut store = LayoutStore::default();
    let ids = tabs(&mut store, "opener", 3);
    let (a, c) = (ids[0].clone(), ids[2].clone());
    let inserted = store.new_terminal_tab("opener", &a, None).expect("tab");
    assert_eq!(active_of(&store, "opener"), inserted);
    store.close_pane("opener", &inserted);
    assert_eq!(shown(&store, "opener", &a).as_deref(), Some(a.as_str()));
    assert_eq!(active_of(&store, "opener"), a);
    assert!(find_pane(&root_of(&store, "opener"), &c).is_some());
}

#[test]
fn close_focus_returns_to_the_most_recently_used_tab_after_switching_around() {
    let mut store = LayoutStore::default();
    let ids = tabs(&mut store, "recent", 3);
    let (a, b, c) = (ids[0].clone(), ids[1].clone(), ids[2].clone());
    store.focus_pane("recent", &a);
    store.focus_pane("recent", &c);
    store.close_pane("recent", &c);
    assert_eq!(active_of(&store, "recent"), a);
    assert!(find_pane(&root_of(&store, "recent"), &b).is_some());
}

#[test]
fn close_focus_keeps_the_neighbour_when_there_is_no_history() {
    let mut store = LayoutStore::default();
    let ids = tabs(&mut store, "plain", 2);
    let stack = tabs_of_pane(&root_of(&store, "plain"), &ids[1]).expect("stack");
    assert_eq!(tab_index(&stack, &ids[1]), Some(1));
    store.close_pane("plain", &ids[1]);
    assert_eq!(active_of(&store, "plain"), ids[0]);
}

#[test]
fn remove_workspace_returns_its_panes_and_drops_the_layout() {
    let mut store = LayoutStore::default();
    let first = store.ensure("w1", None).expect("pane");
    let second = store
        .split("w1", &first, Direction::Horizontal, None)
        .expect("pane");
    assert_eq!(store.remove_workspace("w1"), vec![first, second]);
    assert!(store.layout("w1").is_none());
    assert!(store.remove_workspace("w1").is_empty());
}
