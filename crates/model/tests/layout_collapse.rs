#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::ids::IdMint;
use ostia_model::layout::collapse::{
    CollapseChange, STRIP_SIZE, can_collapse, change_collapse, fold_split_tab, is_strip, is_tucked,
    settle_collapse, strip_axis, strip_sizes,
};
use ostia_model::layout::panel_size::set_sizes;
use ostia_model::layout::tree::{
    create_pane, find_pane, find_split_tab, first_pane_id, is_pane_shown, split_of,
    split_tab_of_pane, tabs_of, tabs_of_pane,
};
use ostia_model::layout::types::{
    Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode,
};

fn pane_node(ids: &mut IdMint) -> PaneNode {
    create_pane(ids, SurfaceKind::Terminal, None, None)
}

fn terminal(ids: &mut IdMint) -> LayoutNode {
    pane_node(ids).into()
}

fn collapsed_pane(ids: &mut IdMint) -> LayoutNode {
    let mut pane = pane_node(ids);
    pane.collapsed = true;
    pane.into()
}

fn split(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> LayoutNode {
    split_of(ids, direction, children).into()
}

fn named_split(ids: &mut IdMint, name: &str, children: Vec<LayoutNode>) -> LayoutNode {
    let mut tab = split_of(ids, Direction::Horizontal, children);
    tab.name = Some(name.to_owned());
    tab.into()
}

fn tab(node: &LayoutNode) -> TabNode {
    node.clone().into_tab().unwrap()
}

fn tabs(ids: &mut IdMint, active: &str, children: &[&LayoutNode]) -> LayoutNode {
    tabs_of(ids, active, children.iter().map(|node| tab(node)).collect()).into()
}

fn folded(node: &LayoutNode) -> LayoutNode {
    let LayoutNode::Split(split) = node else {
        panic!("not a split")
    };
    SplitNode {
        folded: true,
        ..(**split).clone()
    }
    .into()
}

fn owned(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

struct Workers {
    a: LayoutNode,
    b: LayoutNode,
    c: LayoutNode,
    d: LayoutNode,
    lone: LayoutNode,
    root: LayoutNode,
}

fn workers(ids: &mut IdMint) -> Workers {
    let a = terminal(ids);
    let b = terminal(ids);
    let c = terminal(ids);
    let d = terminal(ids);
    let lone = terminal(ids);
    let tab_node = named_split(
        ids,
        "workers",
        vec![a.clone(), b.clone(), c.clone(), d.clone()],
    );
    let root = tabs(ids, a.id(), &[&lone, &tab_node]);
    Workers {
        a,
        b,
        c,
        d,
        lone,
        root,
    }
}

fn collapsed_ids(root: &LayoutNode, pane_id: &str) -> Vec<String> {
    let Some(tab) = split_tab_of_pane(root, pane_id) else {
        return Vec::new();
    };
    ostia_model::layout::tree::all_panes(&LayoutNode::Split(tab))
        .iter()
        .filter(|pane| pane.collapsed)
        .map(|pane| pane.id.clone())
        .collect()
}

fn shown_of(root: &LayoutNode, pane_id: &str) -> Option<String> {
    tabs_of_pane(root, pane_id).map(|tabs| tabs.active_id.clone())
}

fn is_collapsed(root: &LayoutNode, id: &str) -> bool {
    find_pane(root, id).unwrap().collapsed
}

#[test]
fn collapses_a_pane_of_a_split_tab_and_keeps_the_others_expanded() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let next = change_collapse(&w.root, w.b.id(), CollapseChange::Collapse);
    assert_eq!(collapsed_ids(&next, w.b.id()), owned(&[w.b.id()]));
    assert!(!is_pane_shown(&next, w.b.id()));
}

#[test]
fn moves_the_shown_pane_to_the_nearest_expanded_one_when_the_shown_pane_collapses() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let once = change_collapse(&w.root, w.a.id(), CollapseChange::Collapse);
    assert_eq!(shown_of(&once, w.a.id()).as_deref(), Some(w.b.id()));
    let with_c = change_collapse(&once, w.c.id(), CollapseChange::Collapse);
    let twice = change_collapse(&with_c, w.b.id(), CollapseChange::Collapse);
    let shown = shown_of(&twice, w.a.id()).unwrap_or_default();
    assert_ne!(shown, w.b.id());
    assert!(!is_collapsed(&twice, &shown));
}

#[test]
fn never_collapses_the_last_expanded_pane_of_a_split_tab() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let three = [&w.a, &w.b, &w.c]
        .iter()
        .fold(w.root.clone(), |root, pane| {
            change_collapse(&root, pane.id(), CollapseChange::Collapse)
        });
    assert!(change_collapse(&three, w.d.id(), CollapseChange::Collapse).is_same(&three));
    let tab = split_tab_of_pane(&three, w.d.id()).unwrap();
    assert!(!can_collapse(&tab, w.d.id()));
}

#[test]
fn leaves_panes_outside_a_split_tab_and_unknown_panes_alone_same_object() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    assert!(change_collapse(&w.root, w.lone.id(), CollapseChange::Collapse).is_same(&w.root));
    assert!(change_collapse(&w.root, "nope", CollapseChange::Collapse).is_same(&w.root));
    assert!(change_collapse(&w.root, w.lone.id(), CollapseChange::CollapseOthers).is_same(&w.root));
    assert!(change_collapse(&w.root, w.lone.id(), CollapseChange::ExpandAll).is_same(&w.root));
}

#[test]
fn returns_the_same_object_when_a_pane_is_collapsed_already() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let once = change_collapse(&w.root, w.b.id(), CollapseChange::Collapse);
    assert!(change_collapse(&once, w.b.id(), CollapseChange::Collapse).is_same(&once));
}

#[test]
fn collapses_every_other_pane_and_shows_the_kept_one() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let next = change_collapse(&w.root, w.c.id(), CollapseChange::CollapseOthers);
    assert_eq!(
        collapsed_ids(&next, w.c.id()),
        owned(&[w.a.id(), w.b.id(), w.d.id()])
    );
    assert_eq!(shown_of(&next, w.c.id()).as_deref(), Some(w.c.id()));
    assert!(change_collapse(&next, w.c.id(), CollapseChange::CollapseOthers).is_same(&next));
}

#[test]
fn expands_every_pane_of_the_split_tab() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let next = change_collapse(&w.root, w.c.id(), CollapseChange::CollapseOthers);
    let open = change_collapse(&next, w.a.id(), CollapseChange::ExpandAll);
    assert!(collapsed_ids(&open, w.a.id()).is_empty());
    assert!(change_collapse(&open, w.a.id(), CollapseChange::ExpandAll).is_same(&open));
}

#[test]
fn treats_a_sub_split_whose_panes_are_all_collapsed_as_one_strip() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = collapsed_pane(&mut ids);
    let c = collapsed_pane(&mut ids);
    let row = split(&mut ids, Direction::Horizontal, vec![b, c]);
    assert!(is_strip(&row));
    let b2 = collapsed_pane(&mut ids);
    let c2 = terminal(&mut ids);
    let mixed = split(&mut ids, Direction::Horizontal, vec![b2, c2]);
    assert!(!is_strip(&mixed));
    assert!(!is_strip(&a));
}

#[test]
fn names_the_axis_a_pane_collapses_along() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let inner = split(&mut ids, Direction::Horizontal, vec![a.clone(), b]);
    let grid = split_of(&mut ids, Direction::Vertical, vec![inner, c.clone()]);
    assert_eq!(strip_axis(&grid, a.id()), Some(Direction::Horizontal));
    assert_eq!(strip_axis(&grid, c.id()), Some(Direction::Vertical));
    assert_eq!(strip_axis(&grid, "nope"), None);
}

#[test]
fn settle_collapse_returns_the_same_object_when_every_collapsed_pane_is_valid() {
    let mut ids = IdMint::default();
    let w = workers(&mut ids);
    let next = change_collapse(&w.root, w.b.id(), CollapseChange::Collapse);
    assert!(settle_collapse(&next).is_same(&next));
    assert!(settle_collapse(&w.root).is_same(&w.root));
}

#[test]
fn expands_a_pane_that_left_its_split_tab() {
    let mut ids = IdMint::default();
    let pane = collapsed_pane(&mut ids);
    let other = terminal(&mut ids);
    let LayoutNode::Pane(arc) = &pane else {
        panic!("not a pane")
    };
    let mut expected = (**arc).clone();
    expected.collapsed = false;
    assert_eq!(settle_collapse(&pane), LayoutNode::from(expected));
    let outer = split(
        &mut ids,
        Direction::Horizontal,
        vec![pane.clone(), other.clone()],
    );
    let settled = settle_collapse(&outer);
    assert!(!is_collapsed(&settled, pane.id()));
    let stacked = tabs(&mut ids, other.id(), &[&pane, &other]);
    assert!(!is_collapsed(&settle_collapse(&stacked), pane.id()));
}

#[test]
fn expands_the_shown_pane_of_a_stack_and_the_first_pane_of_a_tab_with_none_expanded() {
    let mut ids = IdMint::default();
    let a = collapsed_pane(&mut ids);
    let b = collapsed_pane(&mut ids);
    let c = terminal(&mut ids);
    let tab_node = split(&mut ids, Direction::Horizontal, vec![a.clone(), b.clone()]);
    let shown = settle_collapse(&tabs(&mut ids, b.id(), &[&c, &tab_node]));
    assert!(!is_collapsed(&shown, b.id()));
    assert!(is_collapsed(&shown, a.id()));
    let hidden = settle_collapse(&tabs(&mut ids, c.id(), &[&c, &tab_node]));
    assert!(!is_collapsed(&hidden, a.id()));
    assert!(is_collapsed(&hidden, b.id()));
}

#[test]
fn gives_strips_their_fixed_size_and_shares_the_rest_by_the_stored_proportions() {
    assert_eq!(
        strip_sizes(
            &[300.0, 500.0, 100.0],
            &[false, true, false],
            Some(1000.0 + STRIP_SIZE),
            &[]
        ),
        vec![750.0, STRIP_SIZE, 250.0]
    );
    assert_eq!(
        strip_sizes(
            &[1.0, 1.0, 1.0],
            &[true, false, false],
            Some(2.0 * 500.0 + STRIP_SIZE),
            &[]
        ),
        vec![STRIP_SIZE, 500.0, 500.0]
    );
}

#[test]
fn gives_a_pane_that_just_expanded_its_stored_size_back_and_shrinks_the_others() {
    assert_eq!(
        strip_sizes(
            &[365.0, 704.0],
            &[false, false],
            Some(730.0),
            &[true, false]
        ),
        vec![365.0, 365.0]
    );
    assert_eq!(
        strip_sizes(
            &[900.0, 704.0],
            &[false, false],
            Some(730.0),
            &[true, false]
        ),
        vec![(900.0 / 1604.0) * 730.0, (704.0 / 1604.0) * 730.0]
    );
}

#[test]
fn keeps_the_stored_sizes_when_no_total_is_known() {
    assert_eq!(
        strip_sizes(&[300.0, 500.0, 100.0], &[false, true, false], None, &[]),
        vec![300.0, STRIP_SIZE, 100.0]
    );
}

#[test]
fn keeps_a_strip_childs_stored_size_when_the_split_reports_its_strip_size() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = collapsed_pane(&mut ids);
    let mut inner = split_of(&mut ids, Direction::Horizontal, vec![a, b]);
    inner.sizes = vec![400.0, 600.0];
    let id = inner.id.clone();
    let root: LayoutNode = inner.into();
    let next = set_sizes(&root, &id, &[974.0, STRIP_SIZE]);
    let LayoutNode::Split(next_split) = &next else {
        panic!("not a split")
    };
    assert_eq!(next_split.sizes, vec![974.0, 600.0]);
    assert!(set_sizes(&next, &id, &[974.0, STRIP_SIZE]).is_same(&next));
}

struct Stack {
    lone: LayoutNode,
    a: LayoutNode,
    c: LayoutNode,
    d: LayoutNode,
    first: LayoutNode,
    second: LayoutNode,
}

fn stack(ids: &mut IdMint) -> Stack {
    let lone = terminal(ids);
    let a = terminal(ids);
    let b = terminal(ids);
    let c = terminal(ids);
    let d = terminal(ids);
    let first = named_split(ids, "workers", vec![a.clone(), b]);
    let second = named_split(ids, "more", vec![c.clone(), d.clone()]);
    Stack {
        lone,
        a,
        c,
        d,
        first,
        second,
    }
}

#[test]
fn folds_a_split_tab_that_is_not_shown_and_leaves_the_shown_tab_alone() {
    let mut ids = IdMint::default();
    let s = stack(&mut ids);
    let root = tabs(&mut ids, s.lone.id(), &[&s.lone, &s.first, &s.second]);
    let next = fold_split_tab(&root, s.first.id());
    assert!(find_split_tab(&next, s.first.id()).unwrap().folded);
    assert_eq!(shown_of(&next, s.lone.id()).as_deref(), Some(s.lone.id()));
    assert!(is_tucked(&next, s.a.id()));
    assert!(fold_split_tab(&next, s.first.id()).is_same(&next));
}

#[test]
fn shows_the_next_tab_when_the_shown_split_tab_folds_skipping_folded_tabs_and_collapsed_panes() {
    let mut ids = IdMint::default();
    let s = stack(&mut ids);
    let stacked = tabs(&mut ids, s.c.id(), &[&s.lone, &s.first, &s.second]);
    let tucked = change_collapse(&stacked, s.c.id(), CollapseChange::Collapse);
    let root = fold_split_tab(&tucked, s.first.id());
    assert_eq!(shown_of(&root, s.a.id()).as_deref(), Some(s.d.id()));
    let back = fold_split_tab(&root, s.second.id());
    assert_eq!(shown_of(&back, s.a.id()).as_deref(), Some(s.lone.id()));
}

#[test]
fn refuses_to_fold_the_shown_tab_when_no_other_tab_can_be_shown_and_unknown_ids() {
    let mut ids = IdMint::default();
    let s = stack(&mut ids);
    let stacked = tabs(&mut ids, s.lone.id(), &[&s.lone, &s.first, &s.second]);
    let root = fold_split_tab(&stacked, s.first.id());
    let only_folded = fold_split_tab(&root, s.second.id());
    assert!(find_split_tab(&only_folded, s.second.id()).unwrap().folded);
    let first_child_id = first_pane_id(&s.first).to_owned();
    let solo = tabs(&mut ids, &first_child_id, &[&s.first, &folded(&s.second)]);
    assert!(fold_split_tab(&solo, s.first.id()).is_same(&solo));
    assert!(fold_split_tab(&root, "nope").is_same(&root));
}

#[test]
fn unfolds_the_shown_tab_and_a_split_that_left_its_stack_when_settled() {
    let mut ids = IdMint::default();
    let s = stack(&mut ids);
    let folded_first = folded(&s.first);
    let shown = settle_collapse(&tabs(&mut ids, s.a.id(), &[&s.lone, &folded_first]));
    assert!(!find_split_tab(&shown, s.first.id()).unwrap().folded);
    let hidden = tabs(&mut ids, s.lone.id(), &[&s.lone, &folded_first]);
    assert!(settle_collapse(&hidden).is_same(&hidden));
    let loose = settle_collapse(&split(
        &mut ids,
        Direction::Horizontal,
        vec![s.lone.clone(), folded_first],
    ));
    let LayoutNode::Split(loose_split) = &loose else {
        panic!("not a split")
    };
    let LayoutNode::Split(inner) = &loose_split.children[1] else {
        panic!("not a split")
    };
    assert!(!inner.folded);
}
