#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::ids::IdMint;
use ostia_model::layout::collapse::{fold_split_tab, settle_collapse};
use ostia_model::layout::tab_join::{
    arrange_split_tab, join_split_tab, separate_from_split_tab, split_tab_to_tabs,
};
use ostia_model::layout::tree::{
    all_panes, close_pane, create_pane, find_pane, find_split_tab_by_name, is_pane_shown, pane_ids,
    select_tab, split_of, split_tab_of_pane, tabs_of, tabs_of_pane,
};
use ostia_model::layout::types::{
    Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode,
};

fn panes(ids: &mut IdMint, count: usize) -> Vec<Arc<PaneNode>> {
    (0..count)
        .map(|_| Arc::new(create_pane(ids, SurfaceKind::Terminal, None, None)))
        .collect()
}

fn pane_node(pane: &Arc<PaneNode>) -> LayoutNode {
    LayoutNode::Pane(pane.clone())
}

fn tab_node(pane: &Arc<PaneNode>) -> TabNode {
    TabNode::Pane(pane.clone())
}

fn names_of(panes: &[Arc<PaneNode>]) -> Vec<String> {
    panes.iter().map(|pane| pane.id.clone()).collect()
}

fn stack_of(ids: &mut IdMint, active: &Arc<PaneNode>, members: &[Arc<PaneNode>]) -> LayoutNode {
    tabs_of(ids, &active.id, members.iter().map(tab_node).collect()).into()
}

fn tab_pane_ids(tabs: &ostia_model::layout::types::TabsNode) -> Vec<Vec<String>> {
    tabs.children
        .iter()
        .map(|tab| pane_ids(&tab.to_node()))
        .collect()
}

fn named_tab(root: &LayoutNode, name: &str) -> Arc<SplitNode> {
    find_split_tab_by_name(root, name).unwrap()
}

fn pane_list(tab: &Arc<SplitNode>) -> Vec<Arc<PaneNode>> {
    all_panes(&LayoutNode::Split(tab.clone()))
}

fn join(
    ids: &mut IdMint,
    root: &LayoutNode,
    joining: &[&Arc<PaneNode>],
    name: &str,
    columns: f64,
) -> LayoutNode {
    let joining: Vec<String> = joining.iter().map(|pane| pane.id.clone()).collect();
    join_split_tab(ids, root, &joining, name, columns, None)
}

fn separate(
    ids: &mut IdMint,
    root: &LayoutNode,
    leaving: &[&Arc<PaneNode>],
    columns: f64,
) -> LayoutNode {
    let leaving: Vec<String> = leaving.iter().map(|pane| pane.id.clone()).collect();
    separate_from_split_tab(ids, root, &leaving, columns)
}

struct Stack {
    a: Arc<PaneNode>,
    b: Arc<PaneNode>,
    c: Arc<PaneNode>,
    d: Arc<PaneNode>,
    root: LayoutNode,
}

fn stack(ids: &mut IdMint) -> Stack {
    let members = panes(ids, 4);
    let root = stack_of(ids, &members[0], &members);
    Stack {
        a: members[0].clone(),
        b: members[1].clone(),
        c: members[2].clone(),
        d: members[3].clone(),
        root,
    }
}

#[test]
fn puts_panes_side_by_side_with_equal_sizes_while_they_fit_the_columns() {
    let mut ids = IdMint::default();
    let three = panes(&mut ids, 3);
    let tab = arrange_split_tab(&mut ids, &three, 3.0, Some("workers"), None);
    assert_eq!(tab.direction, Direction::Horizontal);
    assert_eq!(tab.sizes, vec![1.0, 1.0, 1.0]);
    assert_eq!(tab.name, Some("workers".to_owned()));
    let expected: Vec<LayoutNode> = three.iter().map(pane_node).collect();
    assert_eq!(tab.children, expected);
}

#[test]
fn turns_into_a_grid_of_equal_rows_past_the_columns() {
    let mut ids = IdMint::default();
    let five = panes(&mut ids, 5);
    let tab = arrange_split_tab(&mut ids, &five, 3.0, Some("workers"), None);
    assert_eq!(tab.direction, Direction::Vertical);
    assert_eq!(tab.sizes, vec![1.0, 1.0]);
    let rows: Vec<Vec<String>> = tab.children.iter().map(pane_ids).collect();
    assert_eq!(rows, vec![names_of(&five[..3]), names_of(&five[3..])]);
    let four = panes(&mut ids, 4);
    let grid = arrange_split_tab(&mut ids, &four, 3.0, Some("workers"), None);
    let counts: Vec<usize> = grid
        .children
        .iter()
        .map(|row| pane_ids(row).len())
        .collect();
    assert_eq!(counts, vec![2, 2]);
}

#[test]
fn returns_the_current_tab_when_it_already_has_the_arranged_shape() {
    let mut ids = IdMint::default();
    let five = panes(&mut ids, 5);
    let tab = arrange_split_tab(&mut ids, &five, 3.0, Some("workers"), None);
    let same = arrange_split_tab(&mut ids, &pane_list(&tab), 3.0, Some("workers"), Some(&tab));
    assert!(Arc::ptr_eq(&same, &tab));
    let mut more = pane_list(&tab);
    more.push(Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        None,
        None,
    )));
    let grown = arrange_split_tab(&mut ids, &more, 3.0, Some("workers"), Some(&tab));
    assert_eq!(grown.id, tab.id);
    assert!(!Arc::ptr_eq(&grown, &tab));
}

#[test]
fn creates_the_named_tab_where_its_first_pane_was_and_keeps_the_shown_tab() {
    let mut ids = IdMint::default();
    let Stack { a, b, c, d, root } = stack(&mut ids);
    let next = join(&mut ids, &root, &[&c, &b], "workers", 3.0);
    let tabs = tabs_of_pane(&next, &a.id).unwrap();
    assert_eq!(
        tab_pane_ids(&tabs),
        vec![
            vec![a.id.clone()],
            vec![c.id.clone(), b.id.clone()],
            vec![d.id.clone()]
        ]
    );
    assert_eq!(named_tab(&next, "workers").sizes, vec![1.0, 1.0]);
    assert!(is_pane_shown(&next, &a.id));
}

#[test]
fn adds_panes_to_an_existing_tab_of_that_name_and_leaves_its_members_alone() {
    let mut ids = IdMint::default();
    let Stack { a, b, c, d, root } = stack(&mut ids);
    let once = join(&mut ids, &root, &[&b, &c], "workers", 3.0);
    let twice = join(&mut ids, &once, &[&d], "workers", 3.0);
    assert_eq!(
        pane_list(&named_tab(&twice, "workers"))
            .iter()
            .map(|pane| pane.id.clone())
            .collect::<Vec<_>>(),
        vec![b.id.clone(), c.id.clone(), d.id.clone()]
    );
    assert_eq!(
        named_tab(&twice, "workers").id,
        named_tab(&once, "workers").id
    );
    let again = join(&mut ids, &twice, &[&b, &d], "workers", 3.0);
    assert!(again.is_same(&twice));
    assert!(split_tab_of_pane(&twice, &a.id).is_none());
}

#[test]
fn joins_a_lone_pane_to_the_partner_it_is_given_and_to_nothing_without_one() {
    let mut ids = IdMint::default();
    let Stack { b, c, root, .. } = stack(&mut ids);
    assert!(join(&mut ids, &root, &[&c], "workers", 3.0).is_same(&root));
    let next = join_split_tab(
        &mut ids,
        &root,
        std::slice::from_ref(&c.id),
        "workers",
        3.0,
        Some(b.id.as_str()),
    );
    assert_eq!(
        pane_ids(&LayoutNode::Split(named_tab(&next, "workers"))),
        vec![b.id.clone(), c.id.clone()]
    );
}

#[test]
fn takes_a_pane_out_of_another_split_tab() {
    let mut ids = IdMint::default();
    let Stack { a, b, c, d, root } = stack(&mut ids);
    let other = join(&mut ids, &root, &[&a, &b, &c], "api", 3.0);
    let next = join(&mut ids, &other, &[&c, &d], "workers", 3.0);
    assert_eq!(
        pane_ids(&LayoutNode::Split(named_tab(&next, "api"))),
        vec![a.id.clone(), b.id.clone()]
    );
    assert_eq!(
        pane_ids(&LayoutNode::Split(named_tab(&next, "workers"))),
        vec![c.id.clone(), d.id.clone()]
    );
}

#[test]
fn leaves_an_ordinary_split_when_the_tab_would_be_the_only_one() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let split: LayoutNode = split_of(
        &mut ids,
        Direction::Vertical,
        members.iter().map(pane_node).collect(),
    )
    .into();
    let next = join(
        &mut ids,
        &split,
        &[&members[0], &members[1]],
        "workers",
        3.0,
    );
    let LayoutNode::Split(result) = next else {
        panic!("expected a split");
    };
    assert_eq!(result.direction, Direction::Horizontal);
    assert_eq!(result.name, None);
}

#[test]
fn puts_a_pane_into_its_own_tab_after_its_split_tab_and_rearranges_the_rest() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 4);
    let (a, b, c, d) = (&members[0], &members[1], &members[2], &members[3]);
    let stacked = stack_of(&mut ids, a, &members);
    let root = join(&mut ids, &stacked, &[b, c, d], "workers", 2.0);
    let next = separate(&mut ids, &root, &[c], 2.0);
    let tabs = tabs_of_pane(&next, &a.id).unwrap();
    assert_eq!(
        tab_pane_ids(&tabs),
        vec![
            vec![a.id.clone()],
            vec![b.id.clone(), d.id.clone()],
            vec![c.id.clone()]
        ]
    );
    assert_eq!(named_tab(&next, "workers").direction, Direction::Horizontal);
}

#[test]
fn leaves_a_pane_that_is_already_its_own_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = stack_of(&mut ids, &members[0], &members);
    assert!(separate(&mut ids, &root, &[&members[1]], 3.0).is_same(&root));
}

#[test]
fn turns_every_pane_into_its_own_tab_in_place_and_order_keeping_the_shown_pane() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 5);
    let (a, b, c, d, e) = (
        &members[0],
        &members[1],
        &members[2],
        &members[3],
        &members[4],
    );
    let stacked = stack_of(&mut ids, a, &members);
    let joined = join(&mut ids, &stacked, &[b, c, d], "workers", 2.0);
    let root = select_tab(&joined, &c.id);
    let split_id = split_tab_of_pane(&root, &b.id).unwrap().id.clone();
    let next = split_tab_to_tabs(&root, &split_id);
    let tabs = tabs_of_pane(&next, &a.id).unwrap();
    assert_eq!(
        tab_pane_ids(&tabs),
        vec![
            vec![a.id.clone()],
            vec![b.id.clone()],
            vec![c.id.clone()],
            vec![d.id.clone()],
            vec![e.id.clone()]
        ]
    );
    assert!(
        tabs.children
            .iter()
            .all(|tab| matches!(tab, TabNode::Pane(_)))
    );
    assert_eq!(tabs.active_id, c.id);
    assert!(tabs.children[2].is_same(&TabNode::Pane(find_pane(&root, &c.id).unwrap())));
}

#[test]
fn ungroups_a_folded_split_tab() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 3);
    let (a, b, c) = (&members[0], &members[1], &members[2]);
    let stacked = stack_of(&mut ids, a, &members);
    let joined = join(&mut ids, &stacked, &[b, c], "workers", 3.0);
    let id = split_tab_of_pane(&joined, &b.id).unwrap().id.clone();
    let folded = fold_split_tab(&joined, &id);
    let next = split_tab_to_tabs(&folded, &id);
    assert!(split_tab_of_pane(&next, &b.id).is_none());
    assert_eq!(
        pane_ids(&next),
        vec![a.id.clone(), b.id.clone(), c.id.clone()]
    );
}

#[test]
fn returns_the_same_root_for_an_unknown_id_or_a_pane() {
    let mut ids = IdMint::default();
    let members = panes(&mut ids, 2);
    let root = stack_of(&mut ids, &members[0], &members);
    assert!(split_tab_to_tabs(&root, "nope").is_same(&root));
    assert!(split_tab_to_tabs(&root, &members[0].id).is_same(&root));
}

struct Folded {
    lone: Arc<PaneNode>,
    a: Arc<PaneNode>,
    b: Arc<PaneNode>,
    e: Arc<PaneNode>,
    c: Arc<PaneNode>,
    d: Arc<PaneNode>,
    root: LayoutNode,
}

fn folded(ids: &mut IdMint) -> Folded {
    let members = panes(ids, 6);
    let (lone, a, b, e, c, d) = (
        members[0].clone(),
        members[1].clone(),
        members[2].clone(),
        members[3].clone(),
        members[4].clone(),
        members[5].clone(),
    );
    let stacked = stack_of(ids, &lone, &members);
    let joined = join(ids, &stacked, &[&a, &b, &e], "workers", 3.0);
    let tab = named_tab(&joined, "workers");
    let LayoutNode::Tabs(tabs) = &joined else {
        panic!("expected tabs");
    };
    let mut tucked_pane = (*a).clone();
    tucked_pane.collapsed = true;
    let children: Vec<TabNode> = tabs
        .children
        .iter()
        .map(|child| match child {
            TabNode::Split(split) if Arc::ptr_eq(split, &tab) => {
                TabNode::Split(Arc::new(SplitNode {
                    children: vec![tucked_pane.clone().into(), pane_node(&b), pane_node(&e)],
                    folded: true,
                    ..(**split).clone()
                }))
            }
            other => other.clone(),
        })
        .collect();
    let tucked: LayoutNode = ostia_model::layout::types::TabsNode {
        children,
        ..(**tabs).clone()
    }
    .into();
    let root = fold_split_tab(&tucked, &tab.id);
    Folded {
        lone,
        a,
        b,
        e,
        c,
        d,
        root,
    }
}

fn settled(root: &LayoutNode, shown_id: &str) -> LayoutNode {
    settle_collapse(&select_tab(root, shown_id))
}

#[test]
fn keeps_the_fold_the_collapsed_pane_and_the_shown_tab_when_a_pane_joins() {
    let mut ids = IdMint::default();
    let Folded {
        lone, a, c, root, ..
    } = folded(&mut ids);
    let next = settled(&join(&mut ids, &root, &[&c], "workers", 3.0), &lone.id);
    let tab = named_tab(&next, "workers");
    assert!(tab.folded);
    assert!(find_pane(&next, &a.id).unwrap().collapsed);
    assert_eq!(tabs_of_pane(&next, &lone.id).unwrap().active_id, lone.id);
    assert!(pane_ids(&LayoutNode::Split(tab)).contains(&c.id));
}

#[test]
fn keeps_the_fold_the_collapsed_pane_and_the_shown_tab_when_a_pane_leaves() {
    let mut ids = IdMint::default();
    let Folded {
        lone,
        a,
        b,
        e,
        root,
        ..
    } = folded(&mut ids);
    let next = settled(&separate(&mut ids, &root, &[&b], 3.0), &lone.id);
    let tab = named_tab(&next, "workers");
    assert_eq!(
        pane_ids(&LayoutNode::Split(tab.clone())),
        vec![a.id.clone(), e.id.clone()]
    );
    assert!(tab.folded);
    assert!(find_pane(&next, &a.id).unwrap().collapsed);
    assert_eq!(tabs_of_pane(&next, &lone.id).unwrap().active_id, lone.id);
}

#[test]
fn keeps_the_fold_when_a_member_closes() {
    let mut ids = IdMint::default();
    let Folded {
        lone,
        a,
        b,
        e,
        d,
        root,
        ..
    } = folded(&mut ids);
    let grown = join(&mut ids, &root, &[&d], "workers", 3.0);
    let next = settled(&close_pane(&grown, &d.id), &lone.id);
    let tab = named_tab(&next, "workers");
    assert!(tab.folded);
    assert!(find_pane(&next, &a.id).unwrap().collapsed);
    assert_eq!(
        pane_ids(&LayoutNode::Split(tab)),
        vec![a.id.clone(), b.id.clone(), e.id.clone()]
    );
}
