#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::ids::IdMint;
use ostia_model::layout::tab_moves::{
    graft_node, land_tab, move_pane, move_tab, placement_of, take_tab,
};
use ostia_model::layout::tree::{
    create_pane, find_pane, first_pane_id, pane_ids, split_of, split_pane, split_tab_of_pane,
    tabs_of, tabs_of_pane,
};
use ostia_model::layout::types::{
    Direction, DropZone, LayoutNode, PaneNode, PanePlacement, SplitNode, SurfaceKind, TabNode,
};

fn pane(ids: &mut IdMint) -> Arc<PaneNode> {
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

fn stack(ids: &mut IdMint, active: &Arc<PaneNode>, members: &[&Arc<PaneNode>]) -> LayoutNode {
    tabs_of(
        ids,
        &active.id,
        members.iter().map(|member| tab_node(member)).collect(),
    )
    .into()
}

fn id_of(node: &LayoutNode) -> String {
    match node {
        LayoutNode::Pane(pane) => pane.id.clone(),
        _ => "split".to_owned(),
    }
}

fn ids_of(nodes: &[LayoutNode]) -> Vec<String> {
    nodes.iter().map(id_of).collect()
}

fn as_split(node: &LayoutNode) -> Arc<SplitNode> {
    match node {
        LayoutNode::Split(split) => split.clone(),
        other => panic!("expected a split, got {other:?}"),
    }
}

fn two_panes_split(ids: &mut IdMint) -> (LayoutNode, String) {
    let root = pane(ids);
    let added = pane(ids);
    let result = split_pane(
        ids,
        &pane_node(&root),
        &root.id,
        Direction::Horizontal,
        (*added).clone(),
    );
    (result.root, result.new_pane_id.unwrap())
}

fn names(ids: &[&Arc<PaneNode>]) -> Vec<String> {
    ids.iter().map(|pane| pane.id.clone()).collect()
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values
}

fn placement(pane: &Arc<PaneNode>, zone: DropZone) -> PanePlacement {
    PanePlacement {
        pane_id: pane.id.clone(),
        zone,
    }
}

#[test]
fn is_a_no_op_when_dropping_a_pane_on_itself() {
    let mut ids = IdMint::default();
    let (split, _) = two_panes_split(&mut ids);
    let id = first_pane_id(&split).to_owned();
    assert!(move_pane(&mut ids, &split, &id, &id, DropZone::Right).is_same(&split));
}

#[test]
fn re_splits_along_the_dropped_edge_horizontal_to_vertical() {
    let mut ids = IdMint::default();
    let (split, new_pane_id) = two_panes_split(&mut ids);
    let first_id = first_pane_id(&split).to_owned();
    let moved = move_pane(&mut ids, &split, &new_pane_id, &first_id, DropZone::Bottom);
    let result = as_split(&moved);
    assert_eq!(result.direction, Direction::Vertical);
    assert_eq!(ids_of(&result.children), vec![first_id, new_pane_id]);
    assert_eq!(pane_ids(&moved).len(), 2);
}

#[test]
fn merges_the_source_into_the_targets_tabs_on_a_center_drop() {
    let mut ids = IdMint::default();
    let (split, new_pane_id) = two_panes_split(&mut ids);
    let first_id = first_pane_id(&split).to_owned();
    let moved = move_pane(&mut ids, &split, &first_id, &new_pane_id, DropZone::Center);
    let LayoutNode::Tabs(tabs) = &moved else {
        panic!("expected tabs");
    };
    assert_eq!(tabs.active_id, first_id);
    assert_eq!(pane_ids(&moved), vec![new_pane_id, first_id]);
}

#[test]
fn keeps_every_pane_when_relocating_within_a_3_pane_tree() {
    let mut ids = IdMint::default();
    let (a, _) = two_panes_split(&mut ids);
    let extra = pane(&mut ids);
    let target = first_pane_id(&a).to_owned();
    let b = split_pane(&mut ids, &a, &target, Direction::Vertical, (*extra).clone()).root;
    let all = pane_ids(&b);
    let moved = move_pane(&mut ids, &b, &all[2], &all[0], DropZone::Right);
    assert_eq!(sorted(pane_ids(&moved)), sorted(all));
}

#[test]
fn re_inserts_as_a_same_axis_sibling_after_the_target_right_onto_a_row() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b), pane_node(&c)],
    );
    let moved = move_pane(&mut ids, &root, &c.id, &a.id, DropZone::Right);
    let result = as_split(&moved);
    assert_eq!(result.direction, Direction::Horizontal);
    assert_eq!(ids_of(&result.children), names(&[&a, &c, &b]));
    assert_eq!(result.children.len(), 3);
    assert_eq!(result.sizes.len(), 3);
    assert_eq!(pane_ids(&moved).len(), 3);
}

#[test]
fn re_inserts_as_a_same_axis_sibling_before_the_target_left_onto_a_row() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b), pane_node(&c)],
    );
    let moved = move_pane(&mut ids, &root, &c.id, &b.id, DropZone::Left);
    assert_eq!(ids_of(&as_split(&moved).children), names(&[&a, &c, &b]));
}

#[test]
fn re_splits_the_target_on_a_cross_axis_placing_the_source_before_it_top_drop() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b), pane_node(&c)],
    );
    let moved = move_pane(&mut ids, &root, &c.id, &a.id, DropZone::Top);
    let first = as_split(&as_split(&moved).children[0]);
    assert_eq!(first.direction, Direction::Vertical);
    assert_eq!(ids_of(&first.children), names(&[&c, &a]));
    assert_eq!(sorted(pane_ids(&moved)), sorted(names(&[&a, &b, &c])));
}

#[test]
fn descends_into_a_nested_subtree_to_reach_a_deeply_nested_target_right_drop() {
    let mut ids = IdMint::default();
    let (a, b, c, d) = (
        pane(&mut ids),
        pane(&mut ids),
        pane(&mut ids),
        pane(&mut ids),
    );
    let left = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&a), pane_node(&b)],
    );
    let right = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&c), pane_node(&d)],
    );
    let root = split_node(&mut ids, Direction::Horizontal, vec![left, right]);
    let moved = move_pane(&mut ids, &root, &a.id, &c.id, DropZone::Right);
    assert_eq!(sorted(pane_ids(&moved)), sorted(names(&[&a, &b, &c, &d])));
    let result = as_split(&moved);
    assert_eq!(
        ids_of(&result.children),
        vec![b.id.clone(), "split".to_owned()]
    );
    let rhs = as_split(&result.children[1]);
    let nested = as_split(&rhs.children[0]);
    assert_eq!(ids_of(&nested.children), names(&[&c, &a]));
}

#[test]
fn merges_into_the_targets_tabs_on_a_center_drop_while_leaving_a_third_pane_in_place() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b), pane_node(&c)],
    );
    let moved = move_pane(&mut ids, &root, &a.id, &c.id, DropZone::Center);
    let result = as_split(&moved);
    assert!(matches!(result.children[0], LayoutNode::Pane(_)));
    let LayoutNode::Tabs(tabs) = &result.children[1] else {
        panic!("expected tabs");
    };
    assert_eq!(result.children.len(), 2);
    assert_eq!(tabs.active_id, a.id);
    assert_eq!(pane_ids(&moved), names(&[&b, &c, &a]));
}

#[test]
fn collapses_a_2_pane_split_and_re_inserts_the_source_before_the_target_left_drop() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let moved = move_pane(&mut ids, &root, &b.id, &a.id, DropZone::Left);
    let result = as_split(&moved);
    assert_eq!(result.direction, Direction::Horizontal);
    assert_eq!(ids_of(&result.children), names(&[&b, &a]));
    assert_eq!(pane_ids(&moved).len(), 2);
}

#[test]
fn is_a_no_op_when_the_source_pane_id_is_unknown() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let first = first_pane_id(&root).to_owned();
    assert!(move_pane(&mut ids, &root, "ghost", &first, DropZone::Right).is_same(&root));
}

#[test]
fn is_a_no_op_when_the_target_pane_id_is_unknown() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let first = first_pane_id(&root).to_owned();
    assert!(move_pane(&mut ids, &root, &first, "ghost", DropZone::Left).is_same(&root));
}

#[test]
fn remembers_the_tab_before_a_tab_that_leaves_a_stack() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let three = stack(&mut ids, &b, &[&a, &b, &c]);
    assert_eq!(
        placement_of(&three, &b.id),
        Some(placement(&a, DropZone::Center))
    );
    let two = stack(&mut ids, &a, &[&a, &b]);
    assert_eq!(
        placement_of(&two, &a.id),
        Some(placement(&b, DropZone::Center))
    );
}

#[test]
fn remembers_the_neighbor_and_side_of_a_pane_in_a_split() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let row = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    assert_eq!(
        placement_of(&row, &b.id),
        Some(placement(&a, DropZone::Right))
    );
    assert_eq!(
        placement_of(&row, &a.id),
        Some(placement(&b, DropZone::Left))
    );
    let inner = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let column = split_node(&mut ids, Direction::Vertical, vec![inner, pane_node(&c)]);
    assert_eq!(
        placement_of(&column, &c.id),
        Some(placement(&b, DropZone::Bottom))
    );
}

#[test]
fn has_no_placement_for_a_lone_pane() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    assert_eq!(placement_of(&pane_node(&a), &a.id), None);
}

#[test]
fn puts_a_returning_pane_back_as_a_tab_next_to_its_old_neighbor() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let row = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let root = graft_node(
        &mut ids,
        Some(&row),
        pane_node(&c),
        Some(&placement(&a, DropZone::Center)),
    );
    let tabs = tabs_of_pane(&root, &c.id).unwrap();
    let members: Vec<String> = tabs
        .children
        .iter()
        .map(|tab| tab.id().to_owned())
        .collect();
    assert_eq!(members, names(&[&a, &c]));
    assert_eq!(pane_ids(&root), names(&[&a, &c, &b]));
}

#[test]
fn puts_every_tab_of_a_returning_stack_next_to_the_anchor() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let returning = stack(&mut ids, &b, &[&b, &c]);
    let root = graft_node(
        &mut ids,
        Some(&pane_node(&a)),
        returning,
        Some(&placement(&a, DropZone::Center)),
    );
    assert!(matches!(root, LayoutNode::Tabs(_)));
    assert_eq!(pane_ids(&root), names(&[&a, &b, &c]));
}

#[test]
fn splits_beside_the_anchor_on_the_remembered_side() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let column = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&a), pane_node(&b)],
    );
    let root = graft_node(
        &mut ids,
        Some(&column),
        pane_node(&c),
        Some(&placement(&a, DropZone::Left)),
    );
    let first = as_split(&as_split(&root).children[0]);
    assert_eq!(first.direction, Direction::Horizontal);
    assert_eq!(pane_ids(&root), names(&[&c, &a, &b]));
}

#[test]
fn splits_a_returning_split_beside_the_anchor_instead_of_flattening_it_into_tabs() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let returning = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&b), pane_node(&c)],
    );
    let root = graft_node(
        &mut ids,
        Some(&pane_node(&a)),
        returning,
        Some(&placement(&a, DropZone::Center)),
    );
    assert_eq!(as_split(&root).direction, Direction::Horizontal);
    assert_eq!(pane_ids(&root), names(&[&a, &b, &c]));
}

#[test]
fn adds_a_new_split_on_the_right_when_the_anchor_is_gone() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let root = graft_node(
        &mut ids,
        Some(&pane_node(&a)),
        pane_node(&b),
        Some(&placement(&c, DropZone::Center)),
    );
    assert_eq!(as_split(&root).direction, Direction::Horizontal);
    assert_eq!(pane_ids(&root), names(&[&a, &b]));
}

#[test]
fn becomes_the_whole_layout_of_a_workspace_with_no_panes() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    assert!(graft_node(&mut ids, None, pane_node(&a), None).is_same(&pane_node(&a)));
}

#[test]
fn reorders_tabs_inside_one_stack_and_keeps_the_stack() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let original = stack(&mut ids, &a, &[&a, &b, &c]);
    let root = move_tab(&mut ids, &original, &a.id, &c.id, true);
    let LayoutNode::Tabs(tabs) = &root else {
        panic!("expected tabs");
    };
    assert_eq!(tabs.id, original.id());
    assert_eq!(tabs.active_id, a.id);
    assert_eq!(pane_ids(&root), names(&[&b, &c, &a]));
}

#[test]
fn moves_a_pane_from_a_split_into_another_stack_before_the_hovered_tab() {
    let mut ids = IdMint::default();
    let (a, b, c) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let inner = stack(&mut ids, &b, &[&b, &c]);
    let start = split_node(&mut ids, Direction::Horizontal, vec![pane_node(&a), inner]);
    let root = move_tab(&mut ids, &start, &a.id, &c.id, false);
    let LayoutNode::Tabs(tabs) = &root else {
        panic!("expected tabs");
    };
    assert_eq!(tabs.active_id, a.id);
    assert_eq!(pane_ids(&root), names(&[&b, &a, &c]));
}

#[test]
fn turns_a_lone_target_pane_into_a_stack() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let start = split_node(
        &mut ids,
        Direction::Vertical,
        vec![pane_node(&a), pane_node(&b)],
    );
    let root = move_tab(&mut ids, &start, &b.id, &a.id, true);
    assert!(matches!(root, LayoutNode::Tabs(_)));
    assert_eq!(pane_ids(&root), names(&[&a, &b]));
}

#[test]
fn returns_the_same_tree_for_an_unknown_pane_or_a_drop_on_itself() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    assert!(move_tab(&mut ids, &root, &a.id, &a.id, true).is_same(&root));
    assert!(move_tab(&mut ids, &root, "nope", &b.id, true).is_same(&root));
}

struct SplitTabStack {
    a: Arc<PaneNode>,
    b: Arc<PaneNode>,
    c: Arc<PaneNode>,
    root: LayoutNode,
    split: Arc<SplitNode>,
}

fn stack_with_split_tab(ids: &mut IdMint) -> SplitTabStack {
    let (a, b, c) = (pane(ids), pane(ids), pane(ids));
    let base = stack(ids, &b, &[&a, &b]);
    let root = split_pane(ids, &base, &b.id, Direction::Horizontal, (*c).clone()).root;
    let split = split_tab_of_pane(&root, &b.id).expect("expected a split tab");
    SplitTabStack {
        a,
        b,
        c,
        root,
        split,
    }
}

#[test]
fn takes_a_plain_tab_out_of_a_stack_and_picks_its_neighbour_as_successor() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = stack(&mut ids, &b, &[&a, &b]);
    let taken = take_tab(&root, &b.id).unwrap();
    assert!(taken.tab.is_same(&tab_node(&b)));
    assert!(taken.rest.unwrap().is_same(&pane_node(&a)));
    assert_eq!(taken.successor, Some(a.id.clone()));
}

#[test]
fn takes_one_segment_of_a_split_tab_alone_and_leaves_its_sibling() {
    let mut ids = IdMint::default();
    let SplitTabStack { a, b, c, root, .. } = stack_with_split_tab(&mut ids);
    let taken = take_tab(&root, &c.id).unwrap();
    assert!(
        taken
            .tab
            .is_same(&TabNode::Pane(find_pane(&root, &c.id).unwrap()))
    );
    assert_eq!(pane_ids(&taken.rest.unwrap()), names(&[&a, &b]));
    assert_eq!(taken.successor, Some(b.id.clone()));
}

#[test]
fn takes_the_whole_split_tab_by_its_id() {
    let mut ids = IdMint::default();
    let SplitTabStack {
        a,
        b,
        c,
        root,
        split,
    } = stack_with_split_tab(&mut ids);
    let taken = take_tab(&root, &split.id).unwrap();
    assert!(taken.tab.is_same(&TabNode::Split(split.clone())));
    assert_eq!(pane_ids(&taken.tab.to_node()), names(&[&b, &c]));
    assert!(taken.rest.unwrap().is_same(&pane_node(&a)));
    assert_eq!(taken.successor, Some(a.id.clone()));
}

#[test]
fn leaves_nothing_when_the_tab_is_the_whole_layout() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let taken = take_tab(&pane_node(&a), &a.id).unwrap();
    assert!(taken.tab.is_same(&tab_node(&a)));
    assert!(taken.rest.is_none());
    assert!(taken.successor.is_none());
}

#[test]
fn takes_a_pane_out_of_a_plain_split() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let taken = take_tab(&root, &a.id).unwrap();
    assert!(taken.rest.unwrap().is_same(&pane_node(&b)));
    assert_eq!(taken.successor, Some(b.id.clone()));
}

#[test]
fn returns_null_for_an_unknown_id_and_never_changes_the_tree() {
    let mut ids = IdMint::default();
    let SplitTabStack { root, .. } = stack_with_split_tab(&mut ids);
    let before = root.clone();
    assert!(take_tab(&root, "nope").is_none());
    take_tab(&root, &pane_ids(&root)[1]);
    assert_eq!(root, before);
}

#[test]
fn becomes_the_whole_layout_of_an_empty_workspace_a_split_tab_as_an_ordinary_split() {
    let mut ids = IdMint::default();
    let SplitTabStack { split, .. } = stack_with_split_tab(&mut ids);
    let named = SplitNode {
        name: Some("workers".to_owned()),
        ..(*split).clone()
    };
    let landed = land_tab(&mut ids, None, TabNode::Split(Arc::new(named)), "x");
    let result = as_split(&landed);
    assert_eq!(result.id, split.id);
    assert_eq!(result.name, None);
    let loose = pane(&mut ids);
    assert!(land_tab(&mut ids, None, tab_node(&loose), "x").is_same(&pane_node(&loose)));
}

#[test]
fn adds_the_tab_beside_the_anchor_and_shows_it() {
    let mut ids = IdMint::default();
    let (a, b, moved) = (pane(&mut ids), pane(&mut ids), pane(&mut ids));
    let start = stack(&mut ids, &a, &[&a, &b]);
    let landed = land_tab(&mut ids, Some(&start), tab_node(&moved), &a.id);
    let LayoutNode::Tabs(tabs) = &landed else {
        panic!("expected tabs");
    };
    assert_eq!(tabs.active_id, moved.id);
    let members: Vec<String> = tabs
        .children
        .iter()
        .map(|tab| tab.id().to_owned())
        .collect();
    assert_eq!(members, names(&[&a, &moved, &b]));
}

#[test]
fn turns_a_lone_pane_into_a_stack_and_keeps_a_split_tab_whole() {
    let mut ids = IdMint::default();
    let SplitTabStack { split, .. } = stack_with_split_tab(&mut ids);
    let target = pane(&mut ids);
    let landed = land_tab(
        &mut ids,
        Some(&pane_node(&target)),
        TabNode::Split(split.clone()),
        &target.id,
    );
    let LayoutNode::Tabs(tabs) = &landed else {
        panic!("expected tabs");
    };
    assert!(tabs.children[1].is_same(&TabNode::Split(split.clone())));
}

#[test]
fn falls_back_to_the_first_pane_when_the_anchor_is_gone() {
    let mut ids = IdMint::default();
    let (a, b) = (pane(&mut ids), pane(&mut ids));
    let root = split_node(
        &mut ids,
        Direction::Horizontal,
        vec![pane_node(&a), pane_node(&b)],
    );
    let moved = pane(&mut ids);
    let landed = land_tab(&mut ids, Some(&root), tab_node(&moved), "gone");
    assert!(Arc::ptr_eq(&find_pane(&landed, &moved.id).unwrap(), &moved));
    assert_eq!(pane_ids(&landed), names(&[&a, &moved, &b]));
}
