#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::ids::IdMint;
use ostia_model::layout::tab_focus::{TabHistory, focus_after_close, show_after_close};
use ostia_model::layout::tree::{create_pane, tabs_of};
use ostia_model::layout::types::{LayoutNode, SurfaceKind, TabNode};

fn terminal(ids: &mut IdMint) -> LayoutNode {
    create_pane(ids, SurfaceKind::Terminal, None, None).into()
}

fn stack(ids: &mut IdMint, shown: usize, count: usize) -> (LayoutNode, Vec<String>) {
    let panes: Vec<LayoutNode> = (0..count).map(|_| terminal(ids)).collect();
    let pane_ids: Vec<String> = panes.iter().map(|pane| pane.id().to_owned()).collect();
    let tab_nodes: Vec<TabNode> = panes
        .iter()
        .map(|pane| pane.clone().into_tab().unwrap())
        .collect();
    let root = tabs_of(ids, &pane_ids[shown], tab_nodes).into();
    (root, pane_ids)
}

fn history(recent: &[&str], openers: &[(&str, &str)]) -> TabHistory {
    TabHistory {
        recent: recent.iter().map(|id| (*id).to_owned()).collect(),
        openers: openers
            .iter()
            .map(|(tab, opener)| ((*tab).to_owned(), (*opener).to_owned()))
            .collect::<HashMap<String, String>>(),
    }
}

#[test]
fn returns_the_opener_before_any_switch() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 2, 4);
    let past = history(&[], &[(tabs[2].as_str(), tabs[0].as_str())]);
    assert_eq!(
        focus_after_close(&root, &tabs[2], &past).as_deref(),
        Some(tabs[0].as_str())
    );
}

#[test]
fn prefers_the_opener_over_the_most_recently_used_tab() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 2, 4);
    let past = history(
        &[&tabs[3], &tabs[1]],
        &[(tabs[2].as_str(), tabs[0].as_str())],
    );
    assert_eq!(
        focus_after_close(&root, &tabs[2], &past).as_deref(),
        Some(tabs[0].as_str())
    );
}

#[test]
fn returns_the_most_recently_used_tab_when_there_is_no_opener() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 2, 4);
    let past = history(&[&tabs[2], &tabs[0], &tabs[3]], &[]);
    assert_eq!(
        focus_after_close(&root, &tabs[2], &past).as_deref(),
        Some(tabs[0].as_str())
    );
}

#[test]
fn falls_back_to_the_recent_tab_when_the_opener_is_gone_from_the_stack() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 2, 3);
    let past = history(&[&tabs[1]], &[(tabs[2].as_str(), "closed")]);
    assert_eq!(
        focus_after_close(&root, &tabs[2], &past).as_deref(),
        Some(tabs[1].as_str())
    );
}

#[test]
fn returns_none_without_history_so_the_neighbour_applies() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 2, 4);
    let past = history(&[&tabs[2]], &[]);
    assert_eq!(focus_after_close(&root, &tabs[2], &past), None);
}

#[test]
fn ignores_history_of_another_tab_stack() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 1, 2);
    let other = terminal(&mut ids);
    let past = history(&[other.id()], &[(tabs[1].as_str(), other.id())]);
    assert_eq!(focus_after_close(&root, &tabs[1], &past), None);
}

#[test]
fn returns_none_when_the_closed_tab_is_not_the_shown_one() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 0, 3);
    let past = history(&[&tabs[1]], &[]);
    assert_eq!(focus_after_close(&root, &tabs[2], &past), None);
}

#[test]
fn returns_none_for_a_pane_that_is_not_in_a_tab_stack() {
    let mut ids = IdMint::default();
    let pane = terminal(&mut ids);
    assert_eq!(
        focus_after_close(&pane, pane.id(), &TabHistory::default()),
        None
    );
}

#[test]
fn returns_the_same_root_without_a_choice_or_when_the_tab_is_already_shown() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 1, 3);
    assert!(show_after_close(&root, None).is_same(&root));
    assert!(show_after_close(&root, Some(&tabs[1])).is_same(&root));
}

#[test]
fn shows_the_chosen_tab() {
    let mut ids = IdMint::default();
    let (root, tabs) = stack(&mut ids, 1, 3);
    let LayoutNode::Tabs(shown) = show_after_close(&root, Some(&tabs[2])) else {
        panic!("not tabs")
    };
    assert_eq!(shown.active_id, tabs[2]);
}
