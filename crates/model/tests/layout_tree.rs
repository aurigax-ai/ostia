#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::ids::IdMint;
use ostia_model::layout::focus_direction::{FocusDirection, pane_in_direction};
use ostia_model::layout::pane_fields::{
    set_default_pane_title, set_default_pane_titles, set_pane_browser, set_pane_cwd,
    set_pane_editor, set_pane_locked, set_pane_title, set_pane_view,
};
use ostia_model::layout::panel_size::{equalize_sizes, set_sizes};
use ostia_model::layout::tab_moves::{graft_node, move_pane, move_tab, placement_of};
use ostia_model::layout::tree::{
    SplitResult, add_tab, adjacent_tab, adopt_ids, all_panes, background_tab_anchor, close_pane,
    create_pane, create_terminal_pane, find_pane, find_split_tab, find_split_tab_by_name,
    first_pane_id, focus_id_of, is_pane_shown, merge_layouts, pane_ids, select_tab,
    set_split_tab_name, slot_count, slot_key, split_beside, split_of, split_pane,
    split_tab_of_pane, tab_id_of, tab_neighbor, tabs_of, tabs_of_pane, without_panes,
};
use ostia_model::layout::types::{
    Direction, DropZone, LayoutNode, PaneNode, PanePlacement, SplitNode, SurfaceKind, TabNode,
    TabsNode,
};

fn pane(ids: &mut IdMint) -> Arc<PaneNode> {
    Arc::new(create_pane(ids, SurfaceKind::Terminal, None, None))
}

fn pane_of(ids: &mut IdMint, kind: SurfaceKind) -> Arc<PaneNode> {
    Arc::new(create_pane(ids, kind, None, None))
}

fn node(pane: &Arc<PaneNode>) -> LayoutNode {
    LayoutNode::Pane(pane.clone())
}

fn tab(pane: &Arc<PaneNode>) -> TabNode {
    TabNode::Pane(pane.clone())
}

fn tabs(ids: &mut IdMint, active_id: &str, panes: &[&Arc<PaneNode>]) -> LayoutNode {
    let children = panes.iter().map(|pane| tab(pane)).collect();
    tabs_of(ids, active_id, children).into()
}

fn split(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> LayoutNode {
    split_of(ids, direction, children).into()
}

fn lone(ids: &mut IdMint) -> LayoutNode {
    node(&pane(ids))
}

fn pair(ids: &mut IdMint, direction: Direction) -> LayoutNode {
    let first = pane(ids);
    let second = pane(ids);
    split(ids, direction, vec![node(&first), node(&second)])
}

fn expect_split(node: &LayoutNode) -> Arc<SplitNode> {
    let LayoutNode::Split(split) = node else {
        panic!("expected a split");
    };
    split.clone()
}

fn expect_tabs(node: &LayoutNode) -> Arc<TabsNode> {
    let LayoutNode::Tabs(tabs) = node else {
        panic!("expected tabs");
    };
    tabs.clone()
}

fn tab_ids(tabs: &TabsNode) -> Vec<String> {
    tabs.children
        .iter()
        .map(|child| child.id().to_owned())
        .collect()
}

fn node_ids(children: &[LayoutNode]) -> Vec<String> {
    children.iter().map(|child| child.id().to_owned()).collect()
}

fn id_list(panes: &[&Arc<PaneNode>]) -> Vec<String> {
    panes.iter().map(|pane| pane.id.clone()).collect()
}

fn keys(children: &[LayoutNode]) -> Vec<String> {
    children
        .iter()
        .map(|child| slot_key(child).to_owned())
        .collect()
}

fn is_diff(pane: &PaneNode) -> bool {
    pane.kind == SurfaceKind::Diff
}

fn pane_in(root: &LayoutNode, id: &str) -> Arc<PaneNode> {
    find_pane(root, id).expect("pane exists")
}

fn id_number(id: &str) -> u64 {
    id.rsplit('-').next().unwrap().parse().unwrap()
}

fn split_new(
    ids: &mut IdMint,
    root: &LayoutNode,
    target_id: &str,
    direction: Direction,
) -> SplitResult {
    let fresh = create_pane(ids, SurfaceKind::Terminal, None, None);
    split_pane(ids, root, target_id, direction, fresh)
}

fn stack(ids: &mut IdMint) -> (Arc<PaneNode>, Arc<PaneNode>, Arc<PaneNode>, LayoutNode) {
    let a = pane(ids);
    let b = pane(ids);
    let c = pane(ids);
    let root = tabs(ids, &b.id, &[&a, &b]);
    (a, b, c, root)
}

fn split_stack(
    ids: &mut IdMint,
    root: &LayoutNode,
    target: &Arc<PaneNode>,
    direction: Direction,
    with: &Arc<PaneNode>,
) -> LayoutNode {
    split_pane(ids, root, &target.id, direction, (**with).clone()).root
}

#[test]
fn wraps_a_lone_root_pane_into_a_split_with_two_panes() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let result = split_new(&mut ids, &root, root.id(), Direction::Horizontal);
    assert!(matches!(result.root, LayoutNode::Split(_)));
    assert_eq!(pane_ids(&result.root).len(), 2);
    let new_id = result.new_pane_id.unwrap();
    assert!(pane_ids(&result.root).contains(&new_id));
}

#[test]
fn inserts_a_sibling_when_the_parent_runs_the_same_direction() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let a = split_new(&mut ids, &root, root.id(), Direction::Horizontal).root;
    let b = split_new(&mut ids, &a, first_pane_id(&a), Direction::Horizontal).root;
    let outer = expect_split(&b);
    assert!(
        outer
            .children
            .iter()
            .all(|child| matches!(child, LayoutNode::Pane(_)))
    );
    assert_eq!(outer.children.len(), 3);
    assert_eq!(outer.sizes.len(), 3);
}

#[test]
fn nests_a_new_split_when_the_direction_differs() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let a = split_new(&mut ids, &root, root.id(), Direction::Horizontal).root;
    let b = split_new(&mut ids, &a, first_pane_id(&a), Direction::Vertical).root;
    let outer = expect_split(&b);
    assert!(matches!(outer.children[0], LayoutNode::Split(_)));
    assert_eq!(pane_ids(&b).len(), 3);
}

#[test]
fn returns_the_tree_unchanged_for_an_unknown_target() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let result = split_new(&mut ids, &root, "nope", Direction::Horizontal);
    assert!(result.root.is_same(&root));
    assert!(result.new_pane_id.is_none());
}

#[test]
fn collapses_a_split_back_to_a_single_pane_when_one_child_remains() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let result = split_new(&mut ids, &root, root.id(), Direction::Horizontal);
    let closed = close_pane(&result.root, &result.new_pane_id.unwrap());
    assert!(matches!(closed, LayoutNode::Pane(_)));
    assert_eq!(pane_ids(&closed).len(), 1);
}

#[test]
fn never_removes_the_last_pane() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    assert!(close_pane(&root, root.id()).is_same(&root));
}

#[test]
fn prunes_nested_splits_and_collapses_upward() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let a = split_new(&mut ids, &root, root.id(), Direction::Horizontal).root;
    let result = split_new(&mut ids, &a, first_pane_id(&a), Direction::Vertical);
    let b = result.root;
    assert_eq!(pane_ids(&b).len(), 3);
    let c = close_pane(&b, &result.new_pane_id.unwrap());
    assert_eq!(pane_ids(&c).len(), 2);
    let outer = expect_split(&c);
    assert!(
        outer
            .children
            .iter()
            .all(|child| matches!(child, LayoutNode::Pane(_)))
    );
}

#[test]
fn puts_the_source_root_beside_the_target_root_in_a_new_horizontal_split() {
    let mut ids = IdMint::default();
    let target = pair(&mut ids, Direction::Vertical);
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let source = tabs(&mut ids, &b.id, &[&a, &b]);

    let merged = merge_layouts(&mut ids, target.clone(), source.clone());

    let outer = expect_split(&merged);
    assert_eq!(outer.direction, Direction::Horizontal);
    assert_eq!(outer.children, vec![target, source]);
    assert_eq!(outer.sizes, vec![1.0, 1.0]);
}

#[test]
fn keeps_every_pane_id_of_both_layouts_and_leaves_the_inputs_untouched() {
    let mut ids = IdMint::default();
    let target = lone(&mut ids);
    let source = pair(&mut ids, Direction::Horizontal);
    let before = (target.clone(), source.clone());

    let merged = merge_layouts(&mut ids, target.clone(), source.clone());

    assert_eq!(
        pane_ids(&merged),
        [pane_ids(&target), pane_ids(&source)].concat()
    );
    assert_eq!((target, source), before);
}

#[test]
fn keeps_a_single_source_pane_as_its_own_slot_never_a_tab_of_the_target() {
    let mut ids = IdMint::default();
    let t1 = pane(&mut ids);
    let t2 = pane(&mut ids);
    let target = tabs(&mut ids, &t1.id, &[&t1, &t2]);
    let source = pane(&mut ids);

    let merged = merge_layouts(&mut ids, target, node(&source));

    assert!(tabs_of_pane(&merged, &source.id).is_none());
    let kept = tabs_of_pane(&merged, &t1.id).unwrap();
    assert_eq!(tab_ids(&kept), id_list(&[&t1, &t2]));
}

#[test]
fn builds_a_split_with_the_given_direction_children_and_unit_sizes() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let built = split_of(&mut ids, Direction::Vertical, vec![node(&a), node(&b)]);
    assert_eq!(built.direction, Direction::Vertical);
    assert_eq!(built.children, vec![node(&a), node(&b)]);
    assert_eq!(built.sizes, vec![1.0, 1.0]);
    assert!(built.id.starts_with("split-"));
}

#[test]
fn keeps_a_slots_key_when_a_tab_joins_its_lone_pane_so_the_split_around_it_stays_mounted() {
    let mut ids = IdMint::default();
    let terminal = pane(&mut ids);
    let panel = pane_of(&mut ids, SurfaceKind::View);
    let before = split(
        &mut ids,
        Direction::Horizontal,
        vec![node(&terminal), node(&panel)],
    );
    let diff = pane_of(&mut ids, SurfaceKind::Diff);
    let after = add_tab(&mut ids, &before, &panel.id, tab(&diff), false);
    let after_split = expect_split(&after);
    assert!(matches!(after_split.children[1], LayoutNode::Tabs(_)));
    assert_eq!(
        keys(&after_split.children),
        keys(&expect_split(&before).children)
    );
}

#[test]
fn names_a_split_by_its_own_id() {
    let mut ids = IdMint::default();
    let root = pair(&mut ids, Direction::Vertical);
    assert_eq!(slot_key(&root), root.id());
}

#[test]
fn returns_just_the_root_when_it_is_a_lone_pane() {
    let mut ids = IdMint::default();
    let root = pane_of(&mut ids, SurfaceKind::Terminal);
    assert_eq!(all_panes(&node(&root)), vec![root.clone()]);
}

#[test]
fn returns_every_leaf_pane_node_in_tree_order_descending_into_nested_splits() {
    let mut ids = IdMint::default();
    let t1 = pane_of(&mut ids, SurfaceKind::Terminal);
    let e1 = pane_of(&mut ids, SurfaceKind::Editor);
    let e2 = pane_of(&mut ids, SurfaceKind::Editor);
    let inner = split(&mut ids, Direction::Vertical, vec![node(&e1), node(&e2)]);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&t1), inner]);
    assert_eq!(all_panes(&root), vec![t1.clone(), e1.clone(), e2.clone()]);
}

#[test]
fn carries_each_pane_nodes_own_kind_title_cwd_through_untouched() {
    let mut ids = IdMint::default();
    let a = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/work/api"),
    ));
    let b = pane_of(&mut ids, SurfaceKind::Browser);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&a), node(&b)]);
    let panes = all_panes(&root);
    assert_eq!(
        panes.iter().map(|pane| pane.kind).collect::<Vec<_>>(),
        vec![SurfaceKind::Terminal, SurfaceKind::Browser]
    );
    assert_eq!(panes[0].title, "zsh");
    assert_eq!(panes[0].cwd.as_deref(), Some("/work/api"));
}

#[test]
fn removes_every_pane_of_the_kind_and_collapses_single_child_splits() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let d1 = pane_of(&mut ids, SurfaceKind::Diff);
    let d2 = pane_of(&mut ids, SurfaceKind::Diff);
    let inner = split(&mut ids, Direction::Vertical, vec![node(&d1), node(&d2)]);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&a), inner]);
    let kept = without_panes(&root, &is_diff).unwrap();
    assert!(kept.is_same(&node(&a)));
}

#[test]
fn returns_the_same_object_when_nothing_matches_and_null_when_everything_does() {
    let mut ids = IdMint::default();
    let root = pair(&mut ids, Direction::Horizontal);
    assert!(without_panes(&root, &is_diff).unwrap().is_same(&root));
    let diff = pane_of(&mut ids, SurfaceKind::Diff);
    assert!(without_panes(&node(&diff), &is_diff).is_none());
}

#[test]
fn keeps_the_sizes_of_the_surviving_children() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let diff = pane_of(&mut ids, SurfaceKind::Diff);
    let b = pane(&mut ids);
    let mut sized = split_of(
        &mut ids,
        Direction::Horizontal,
        vec![node(&a), node(&diff), node(&b)],
    );
    sized.sizes = vec![2.0, 1.0, 3.0];
    let root: LayoutNode = sized.into();
    let kept = without_panes(&root, &is_diff).unwrap();
    assert_eq!(expect_split(&kept).sizes, vec![2.0, 3.0]);
}

#[test]
fn splits_a_pane_nested_inside_a_child_split_adding_a_same_axis_sibling_there() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let inner = split(&mut ids, Direction::Vertical, vec![node(&b), node(&c)]);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&a), inner]);
    let result = split_new(&mut ids, &root, &c.id, Direction::Vertical);
    let new_id = result.new_pane_id.unwrap();
    assert_eq!(pane_ids(&result.root).len(), 4);
    let outer = expect_split(&result.root);
    let inner = expect_split(&outer.children[1]);
    assert_eq!(inner.children.len(), 3);
    assert_eq!(inner.sizes.len(), 3);
    assert!(pane_ids(&outer.children[1]).contains(&new_id));
}

#[test]
fn returns_null_and_adds_no_pane_for_an_unknown_target_inside_a_split_root() {
    let mut ids = IdMint::default();
    let first = lone(&mut ids);
    let inner = pair(&mut ids, Direction::Vertical);
    let root = split(&mut ids, Direction::Horizontal, vec![first, inner]);
    let result = split_new(&mut ids, &root, "ghost", Direction::Horizontal);
    assert!(result.new_pane_id.is_none());
    assert_eq!(pane_ids(&result.root), pane_ids(&root));
    assert_eq!(pane_ids(&result.root).len(), 3);
}

#[test]
fn split_pane_tolerates_a_too_short_sizes_array_keeping_sizes_aligned_to_children() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&a), node(&b)]);
    let root = set_sizes(&root, root.id(), &[1.0]);
    let result = split_new(&mut ids, &root, &b.id, Direction::Horizontal);
    assert!(result.new_pane_id.is_some());
    let next = expect_split(&result.root);
    assert_eq!(next.children.len(), 3);
    assert_eq!(next.sizes.len(), next.children.len());
    assert!(next.sizes.iter().all(|size| *size > 0.0));
}

#[test]
fn close_pane_tolerates_a_too_short_sizes_array_pruning_with_aligned_sizes() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![node(&a), node(&b), node(&c)],
    );
    let root = set_sizes(&root, root.id(), &[1.0, 1.0]);
    let closed = close_pane(&root, &a.id);
    let next = expect_split(&closed);
    assert_eq!(pane_ids(&closed), id_list(&[&b, &c]));
    assert_eq!(next.sizes.len(), next.children.len());
    assert!(next.sizes.iter().all(|size| *size > 0.0));
}

#[test]
fn close_pane_returns_a_childless_split_unchanged_nothing_to_prune() {
    let mut ids = IdMint::default();
    let empty = split(&mut ids, Direction::Horizontal, Vec::new());
    let result = close_pane(&empty, "ghost");
    assert!(result.is_same(&empty));
    assert_eq!(expect_split(&result).children.len(), 0);
}

#[test]
fn advances_the_counter_past_a_restored_id_so_the_next_pane_cannot_collide() {
    let mut ids = IdMint::default();
    let restored = LayoutNode::from(PaneNode::new("pane-7", "zsh", SurfaceKind::Terminal));
    adopt_ids(&restored, &mut ids);
    assert_eq!(pane(&mut ids).id, "pane-8");
}

#[test]
fn walks_the_whole_tree_not_just_the_root() {
    let mut ids = IdMint::default();
    let deep = split(
        &mut ids,
        Direction::Vertical,
        vec![LayoutNode::from(PaneNode::new(
            "pane-9",
            "zsh",
            SurfaceKind::Terminal,
        ))],
    );
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![
            LayoutNode::from(PaneNode::new("pane-2", "zsh", SurfaceKind::Terminal)),
            deep,
        ],
    );
    adopt_ids(&root, &mut ids);
    assert_eq!(pane(&mut ids).id, "pane-10");
}

#[test]
fn counts_split_ids_too_panes_and_splits_share_one_counter() {
    let mut ids = IdMint::default();
    let root = LayoutNode::from(SplitNode {
        id: "split-12".to_owned(),
        direction: Direction::Horizontal,
        children: vec![LayoutNode::from(PaneNode::new(
            "pane-1",
            "zsh",
            SurfaceKind::Terminal,
        ))],
        sizes: vec![1.0],
        name: None,
        folded: false,
    });
    adopt_ids(&root, &mut ids);
    assert_eq!(pane(&mut ids).id, "pane-13");
}

#[test]
fn never_rewinds_the_counter() {
    let mut ids = IdMint::default();
    pane(&mut ids);
    pane(&mut ids);
    let restored = LayoutNode::from(PaneNode::new("pane-1", "zsh", SurfaceKind::Terminal));
    adopt_ids(&restored, &mut ids);
    assert_eq!(pane(&mut ids).id, "pane-3");
}

#[test]
fn ignores_ids_that_do_not_end_in_a_number() {
    let mut ids = IdMint::default();
    let restored = LayoutNode::from(PaneNode::new(
        "restored-from-phone",
        "zsh",
        SurfaceKind::Terminal,
    ));
    adopt_ids(&restored, &mut ids);
    assert_eq!(pane(&mut ids).id, "pane-1");
}

#[test]
fn turns_a_lone_pane_into_tabs_and_shows_the_new_tab() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let root = add_tab(&mut ids, &node(&a), &a.id, tab(&b), false);
    assert_eq!(expect_tabs(&root).active_id, b.id);
    assert_eq!(pane_ids(&root), id_list(&[&a, &b]));
    assert!(!is_pane_shown(&root, &a.id));
    assert!(is_pane_shown(&root, &b.id));
}

#[test]
fn inserts_a_new_tab_right_after_the_tab_it_was_opened_from() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let existing = tabs(&mut ids, &a.id, &[&a, &b]);
    let root = add_tab(&mut ids, &existing, &a.id, tab(&c), false);
    assert_eq!(pane_ids(&root), id_list(&[&a, &c, &b]));
}

#[test]
fn adds_a_tab_inside_a_split_without_touching_the_other_side() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let side_by_side = split(&mut ids, Direction::Horizontal, vec![node(&a), node(&b)]);
    let root = add_tab(&mut ids, &side_by_side, &b.id, tab(&c), false);
    assert!(expect_split(&root).children[0].is_same(&node(&a)));
    let grown = tabs_of_pane(&root, &c.id).unwrap();
    assert_eq!(tab_ids(&grown), id_list(&[&b, &c]));
}

#[test]
fn adds_a_background_tab_without_changing_which_tab_is_shown() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let single = add_tab(&mut ids, &node(&a), &a.id, tab(&b), true);
    assert_eq!(expect_tabs(&single).active_id, a.id);
    assert_eq!(pane_ids(&single), id_list(&[&a, &b]));

    let existing = tabs(&mut ids, &b.id, &[&a, &b]);
    let grown = add_tab(&mut ids, &existing, &a.id, tab(&c), true);
    assert_eq!(expect_tabs(&grown).active_id, b.id);
    assert_eq!(pane_ids(&grown), id_list(&[&a, &c, &b]));
}

#[test]
fn opens_background_tabs_from_one_caller_right_after_it_in_launch_order() {
    let mut ids = IdMint::default();
    let agent = pane(&mut ids);
    let other = pane(&mut ids);
    let mut opened: Vec<String> = Vec::new();
    let mut root = tabs(&mut ids, &agent.id, &[&agent, &other]);
    for _ in 0..3 {
        let fresh = pane(&mut ids);
        let anchor = background_tab_anchor(&root, &agent.id, &opened);
        root = add_tab(&mut ids, &root, &anchor, tab(&fresh), true);
        opened.push(fresh.id.clone());
    }
    let expected = [vec![agent.id.clone()], opened, vec![other.id.clone()]].concat();
    assert_eq!(pane_ids(&root), expected);
    assert_eq!(expect_tabs(&root).active_id, agent.id);
}

#[test]
fn skips_the_callers_tabs_that_left_its_stack_and_ignores_another_callers_tabs() {
    let mut ids = IdMint::default();
    let agent = pane(&mut ids);
    let moved = pane(&mut ids);
    let kept = pane(&mut ids);
    let foreign = pane(&mut ids);
    let stacked = tabs(&mut ids, &agent.id, &[&agent, &kept, &foreign]);
    let root = split(&mut ids, Direction::Horizontal, vec![stacked, node(&moved)]);
    assert_eq!(
        background_tab_anchor(&root, &agent.id, &id_list(&[&kept, &moved])),
        kept.id
    );
    assert_eq!(
        background_tab_anchor(
            &root,
            &agent.id,
            &[moved.id.clone(), "pane-closed".to_owned()]
        ),
        agent.id
    );
    assert_eq!(background_tab_anchor(&root, &agent.id, &[]), agent.id);
    assert_eq!(
        background_tab_anchor(&node(&agent), &agent.id, &id_list(&[&kept])),
        agent.id
    );
}

#[test]
fn selects_a_tab_and_returns_the_same_tree_when_it_is_already_shown() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let root = tabs(&mut ids, &a.id, &[&a, &b]);
    assert!(select_tab(&root, &a.id).is_same(&root));
    assert_eq!(expect_tabs(&select_tab(&root, &b.id)).active_id, b.id);
}

#[test]
fn shows_the_next_tab_when_the_shown_tab_closes() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let existing = tabs(&mut ids, &b.id, &[&a, &b, &c]);
    let root = close_pane(&existing, &b.id);
    assert_eq!(expect_tabs(&root).active_id, c.id);
    assert_eq!(pane_ids(&root), id_list(&[&a, &c]));
}

#[test]
fn collapses_back_to_a_plain_pane_when_one_tab_is_left() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let existing = tabs(&mut ids, &a.id, &[&a, &b]);
    assert!(close_pane(&existing, &a.id).is_same(&node(&b)));
}

#[test]
fn splits_beside_the_whole_tab_stack_with_split_beside() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let stacked = tabs(&mut ids, &b.id, &[&a, &b]);
    let fresh = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    let result = split_beside(&mut ids, &stacked, &b.id, Direction::Vertical, fresh);
    let outer = expect_split(&result.root);
    assert!(outer.children[0].is_same(&stacked));
    assert_eq!(Some(outer.children[1].id().to_owned()), result.new_pane_id);
}

#[test]
fn moves_a_tab_out_to_an_edge_leaving_the_rest_as_a_pane() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let stacked = tabs(&mut ids, &a.id, &[&a, &b]);
    let moved = move_pane(&mut ids, &stacked, &a.id, &b.id, DropZone::Right);
    assert_eq!(node_ids(&expect_split(&moved).children), id_list(&[&b, &a]));
}

#[test]
fn ignores_a_center_drop_onto_a_tab_of_the_same_stack() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let root = tabs(&mut ids, &a.id, &[&a, &b]);
    assert!(move_pane(&mut ids, &root, &a.id, &b.id, DropZone::Center).is_same(&root));
}

#[test]
fn drops_diff_tabs_and_keeps_the_shown_tab_valid() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let mut raw = (*pane(&mut ids)).clone();
    raw.kind = SurfaceKind::Diff;
    let d = Arc::new(raw);
    let b = pane(&mut ids);
    let existing = tabs(&mut ids, &d.id, &[&a, &d, &b]);
    let root = without_panes(&existing, &is_diff).unwrap();
    assert_eq!(expect_tabs(&root).active_id, b.id);
}

#[test]
fn reads_tab_panes_through_find_pane_first_pane_id_and_adopt_ids() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let root = tabs(&mut ids, &b.id, &[&a, &b]);
    assert!(Arc::ptr_eq(&find_pane(&root, &a.id).unwrap(), &a));
    assert_eq!(first_pane_id(&root), b.id);
    ids = IdMint::default();
    adopt_ids(&root, &mut ids);
    assert!(id_number(&pane(&mut ids).id) > id_number(root.id()));
}

#[test]
fn marks_a_terminal_created_without_a_title_as_holding_its_default_title() {
    let mut ids = IdMint::default();
    let created = pane(&mut ids);
    assert_eq!(created.kind, SurfaceKind::Terminal);
    assert_eq!(created.title, "Terminal");
    assert!(created.default_title);
    let named = create_terminal_pane(&mut ids, "終端機", Some("/srv"));
    assert_eq!(named.kind, SurfaceKind::Terminal);
    assert_eq!(named.title, "終端機");
    assert_eq!(named.cwd.as_deref(), Some("/srv"));
    assert!(named.default_title);
}

#[test]
fn does_not_mark_a_terminal_created_with_a_title_or_a_pane_of_another_kind() {
    let mut ids = IdMint::default();
    let titled = create_pane(&mut ids, SurfaceKind::Terminal, Some("pnpm dev"), None);
    assert!(!titled.default_title);
    assert!(!pane_of(&mut ids, SurfaceKind::Editor).default_title);
    assert!(!pane_of(&mut ids, SurfaceKind::Browser).default_title);
}

#[test]
fn names_an_untouched_terminal_after_its_shell_and_keeps_it_open_to_the_next_shell() {
    let mut ids = IdMint::default();
    let created = pane(&mut ids);
    let root = node(&created);
    let bash = set_default_pane_title(&root, &created.id, "bash");
    let bash_pane = pane_in(&bash, &created.id);
    assert_eq!(bash_pane.title, "bash");
    assert!(bash_pane.default_title);
    let fish = set_default_pane_title(&bash, &created.id, "fish");
    assert_eq!(pane_in(&fish, &created.id).title, "fish");
    assert!(set_default_pane_title(&bash, &created.id, "bash").is_same(&bash));
}

#[test]
fn keeps_a_title_a_program_or_a_caller_set_when_the_shell_is_reported() {
    let mut ids = IdMint::default();
    let created = pane(&mut ids);
    let titled = set_pane_title(&node(&created), &created.id, "claude: fix the login bug");
    let expected = PaneNode {
        title: "claude: fix the login bug".to_owned(),
        default_title: false,
        ..(*created).clone()
    };
    assert_eq!(*pane_in(&titled, &created.id), expected);
    assert!(set_default_pane_title(&titled, &created.id, "bash").is_same(&titled));
    let given = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("pnpm dev"),
        None,
    ));
    let given_root = node(&given);
    assert!(set_default_pane_title(&given_root, &given.id, "bash").is_same(&given_root));
}

#[test]
fn treats_a_program_title_equal_to_the_shell_name_as_set_so_a_later_shell_keeps_it() {
    let mut ids = IdMint::default();
    let created = pane(&mut ids);
    let bash = set_default_pane_title(&node(&created), &created.id, "bash");
    let titled = set_pane_title(&bash, &created.id, "bash");
    assert!(!pane_in(&titled, &created.id).default_title);
    assert!(set_default_pane_title(&titled, &created.id, "zsh").is_same(&titled));
    assert!(set_pane_title(&titled, &created.id, "bash").is_same(&titled));
}

#[test]
fn resets_every_untouched_terminal_of_a_tree_to_one_title_and_leaves_the_others() {
    let mut ids = IdMint::default();
    let fresh = pane(&mut ids);
    let untouched = Arc::new(PaneNode {
        title: "bash".to_owned(),
        ..(*fresh).clone()
    });
    let named = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("pnpm dev"),
        None,
    ));
    let editor = Arc::new(create_pane(
        &mut ids,
        SurfaceKind::Editor,
        Some("a.ts"),
        None,
    ));
    let stacked = tabs(&mut ids, &named.id, &[&named, &editor]);
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![node(&untouched), stacked],
    );
    let reset = set_default_pane_titles(&root, "Terminal");
    let titles: Vec<String> = all_panes(&reset)
        .iter()
        .map(|pane| pane.title.clone())
        .collect();
    assert_eq!(titles, vec!["Terminal", "pnpm dev", "a.ts"]);
    assert!(set_default_pane_titles(&reset, "Terminal").is_same(&reset));
}

#[test]
fn drops_the_mark_when_the_pane_becomes_an_editor_a_browser_or_a_view() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let editor = set_pane_editor(&node(&a), &a.id, "a.ts", "/srv/a.ts");
    let browser = set_pane_browser(&node(&b), &b.id, "https://example.com/", None);
    let panel = set_pane_view(&node(&c), &c.id, "deploys", "Deploys");
    assert!(!pane_in(&editor, &a.id).default_title);
    assert!(!pane_in(&browser, &b.id).default_title);
    assert!(!pane_in(&panel, &c.id).default_title);
}

#[test]
fn splits_with_the_pane_it_is_given() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    let fresh = create_terminal_pane(&mut ids, "終端機", None);
    let expected = fresh.clone();
    let result = split_pane(&mut ids, &root, root.id(), Direction::Horizontal, fresh);
    assert_eq!(result.new_pane_id.as_deref(), Some(expected.id.as_str()));
    assert_eq!(*pane_in(&result.root, &expected.id), expected);
}

#[test]
fn steps_through_the_tabs_of_the_pane_and_wraps_at_both_ends() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let root = tabs(&mut ids, &a.id, &[&a, &b, &c]);
    assert_eq!(adjacent_tab(&root, &a.id, 1), Some(b.id.clone()));
    assert_eq!(adjacent_tab(&root, &c.id, 1), Some(a.id.clone()));
    assert_eq!(adjacent_tab(&root, &a.id, -1), Some(c.id.clone()));
    assert_eq!(adjacent_tab(&root, &b.id, -1), Some(a.id.clone()));
}

#[test]
fn finds_the_tab_group_inside_a_split() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let group = tabs(&mut ids, &b.id, &[&b, &c]);
    let root = split(&mut ids, Direction::Horizontal, vec![node(&a), group]);
    assert_eq!(adjacent_tab(&root, &b.id, 1), Some(c.id.clone()));
}

#[test]
fn returns_null_for_a_pane_that_is_not_in_a_tab_group() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    assert_eq!(adjacent_tab(&node(&a), &a.id, 1), None);
    let root = split(&mut ids, Direction::Vertical, vec![node(&a), node(&b)]);
    assert_eq!(adjacent_tab(&root, &a.id, -1), None);
}

#[test]
fn turns_the_shown_tab_of_a_stack_into_a_split_tab_when_it_splits() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let result = split_pane(&mut ids, &root, &b.id, Direction::Horizontal, (*c).clone());
    assert_eq!(result.new_pane_id.as_deref(), Some(c.id.as_str()));
    let next = expect_tabs(&result.root);
    assert_eq!(next.id, root.id());
    assert_eq!(next.active_id, b.id);
    assert!(next.children[0].is_same(&tab(&a)));
    let TabNode::Split(shown) = &next.children[1] else {
        panic!("expected a split tab");
    };
    assert_eq!(shown.direction, Direction::Horizontal);
    assert_eq!(pane_ids(&next.children[1].to_node()), id_list(&[&b, &c]));
    assert_eq!(split_tab_of_pane(&result.root, &c.id).unwrap().id, shown.id);
}

#[test]
fn splits_a_lone_pane_slot_as_before() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let result = split_new(&mut ids, &node(&a), &a.id, Direction::Vertical);
    assert_eq!(expect_split(&result.root).direction, Direction::Vertical);
}

#[test]
fn grows_a_split_tab_inside_itself_nesting_another_direction() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let d = pane(&mut ids);
    let once = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let twice = split_stack(&mut ids, &once, &c, Direction::Vertical, &d);
    let grown = split_tab_of_pane(&twice, &d.id).unwrap();
    assert_eq!(grown.direction, Direction::Horizontal);
    assert_eq!(
        expect_split(&grown.children[1]).direction,
        Direction::Vertical
    );
    assert_eq!(pane_ids(&twice).len(), 4);
    assert_eq!(expect_tabs(&twice).children.len(), 2);
}

#[test]
fn adds_a_sibling_in_the_same_direction_instead_of_nesting() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let d = pane(&mut ids);
    let once = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let twice = split_stack(&mut ids, &once, &c, Direction::Horizontal, &d);
    let grown = split_tab_of_pane(&twice, &d.id).unwrap();
    assert_eq!(node_ids(&grown.children), id_list(&[&b, &c, &d]));
    assert_eq!(grown.sizes, vec![1.0, 0.5, 0.5]);
}

#[test]
fn shows_only_the_panes_of_the_shown_tab() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    assert!(is_pane_shown(&next, &b.id));
    assert!(is_pane_shown(&next, &c.id));
    assert!(!is_pane_shown(&next, &a.id));
    let other = select_tab(&next, &a.id);
    assert!(!is_pane_shown(&other, &c.id));
    let selected = select_tab(&next, &c.id);
    assert_eq!(expect_tabs(&selected).active_id, c.id);
    assert!(is_pane_shown(&selected, &b.id));
}

#[test]
fn turns_a_split_tab_closed_down_to_one_pane_back_into_a_plain_tab() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let closed = expect_tabs(&close_pane(&next, &b.id));
    assert_eq!(closed.active_id, c.id);
    assert_eq!(closed.children, vec![tab(&a), tab(&c)]);
}

#[test]
fn keeps_focus_inside_the_split_tab_when_its_focused_pane_closes() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let d = pane(&mut ids);
    let once = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let next = split_stack(&mut ids, &once, &c, Direction::Horizontal, &d);
    let focused = select_tab(&next, &c.id);
    assert_eq!(expect_tabs(&close_pane(&focused, &c.id)).active_id, b.id);
}

#[test]
fn unwraps_a_lone_split_tab_to_an_ordinary_split_without_its_name() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let split_root = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&split_root, &b.id).unwrap_or_default();
    let named = set_split_tab_name(&split_root, &tab_id, Some("api"));
    assert!(find_split_tab_by_name(&named, "api").is_some());
    let closed = close_pane(&named, &a.id);
    assert!(expect_split(&closed).name.is_none());
    assert_eq!(pane_ids(&closed), id_list(&[&b, &c]));
}

#[test]
fn names_renames_and_clears_a_split_tab_and_finds_it_by_name_and_id() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&next, &c.id).unwrap_or_default();
    let named = set_split_tab_name(&next, &tab_id, Some("api"));
    let found = find_split_tab_by_name(&named, "api").unwrap();
    assert_eq!(found.id, tab_id);
    assert_eq!(found.name.as_deref(), Some("api"));
    assert!(Arc::ptr_eq(
        &find_split_tab(&named, &tab_id).unwrap(),
        &found
    ));
    assert!(set_split_tab_name(&named, &tab_id, Some("api")).is_same(&named));
    let renamed = set_split_tab_name(&named, &tab_id, Some("web"));
    assert_eq!(
        find_split_tab(&renamed, &tab_id).unwrap().name.as_deref(),
        Some("web")
    );
    let cleared = set_split_tab_name(&named, &tab_id, None);
    assert!(find_split_tab(&cleared, &tab_id).unwrap().name.is_none());
    assert!(set_split_tab_name(&root, &b.id, Some("web")).is_same(&root));
}

#[test]
fn steps_tabs_not_panes_with_adjacent_tab_and_tab_neighbor() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&next, &c.id);
    assert_ne!(tab_id, Some(c.id.clone()));
    assert_eq!(adjacent_tab(&next, &c.id, 1), Some(a.id.clone()));
    assert_eq!(adjacent_tab(&next, &a.id, 1), Some(b.id.clone()));
    assert_eq!(tab_neighbor(&next, &a.id, 1), tab_id);
    assert_eq!(tab_neighbor(&next, &c.id, -1), Some(a.id.clone()));
}

#[test]
fn moves_the_whole_split_tab_in_the_strip_and_keeps_its_focused_pane_shown() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let split_root = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let next = select_tab(&split_root, &c.id);
    let tab_id = tab_id_of(&next, &c.id).unwrap_or_default();
    let moved = move_tab(&mut ids, &next, &tab_id, &a.id, false);
    let strip = expect_tabs(&moved);
    assert_eq!(tab_ids(&strip), vec![tab_id.clone(), a.id.clone()]);
    assert_eq!(strip.active_id, c.id);
    assert_eq!(focus_id_of(&moved, &tab_id), Some(c.id.clone()));
}

#[test]
fn pulls_one_segment_out_of_a_split_tab_as_its_own_tab() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let moved = expect_tabs(&move_tab(&mut ids, &next, &c.id, &a.id, false));
    assert_eq!(moved.children, vec![tab(&c), tab(&a), tab(&b)]);
    assert_eq!(moved.active_id, c.id);
}

#[test]
fn drops_a_pane_on_the_edge_of_a_pane_in_a_stack_into_that_tab() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    let stacked = tabs(&mut ids, &a.id, &[&a, &b]);
    let root = split(&mut ids, Direction::Horizontal, vec![stacked, node(&c)]);
    let moved = move_pane(&mut ids, &root, &c.id, &a.id, DropZone::Bottom);
    assert!(matches!(moved, LayoutNode::Tabs(_)));
    let grown = split_tab_of_pane(&moved, &c.id).unwrap();
    assert_eq!(grown.direction, Direction::Vertical);
    assert_eq!(pane_ids(&LayoutNode::Split(grown)), id_list(&[&a, &c]));
}

#[test]
fn moves_a_whole_split_tab_to_an_edge_of_a_plain_slot_as_an_ordinary_split() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let d = pane(&mut ids);
    let split_root = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&split_root, &b.id).unwrap_or_default();
    let with_tab = set_split_tab_name(&split_root, &tab_id, Some("api"));
    let tree = split(&mut ids, Direction::Horizontal, vec![with_tab, node(&d)]);
    let tab_id = tab_id_of(&tree, &b.id).unwrap_or_default();
    let moved = move_pane(&mut ids, &tree, &tab_id, &d.id, DropZone::Bottom);
    let outer = expect_split(&expect_split(&moved).children[1]);
    assert_eq!(outer.direction, Direction::Vertical);
    let inner = expect_split(&outer.children[1]);
    assert_eq!(inner.id, tab_id);
    assert!(inner.name.is_none());
}

#[test]
fn adds_a_split_tab_dropped_on_the_center_as_a_tab_keeping_its_name() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let d = pane(&mut ids);
    let split_root = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&split_root, &b.id).unwrap_or_default();
    let with_tab = set_split_tab_name(&split_root, &tab_id, Some("api"));
    let tree = split(&mut ids, Direction::Horizontal, vec![with_tab, node(&d)]);
    let tab_id = tab_id_of(&tree, &b.id).unwrap_or_default();
    let moved = move_pane(&mut ids, &tree, &tab_id, &d.id, DropZone::Center);
    let grown = tabs_of_pane(&moved, &d.id).unwrap();
    assert_eq!(tab_ids(&grown), vec![d.id.clone(), tab_id.clone()]);
    assert_eq!(
        find_split_tab(&moved, &tab_id).unwrap().name.as_deref(),
        Some("api")
    );
}

#[test]
fn walks_the_shown_split_tab_when_moving_focus_by_direction() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let e = pane(&mut ids);
    let stacked = split_stack(&mut ids, &root, &b, Direction::Vertical, &c);
    let tree = split(&mut ids, Direction::Horizontal, vec![node(&e), stacked]);
    assert_eq!(
        pane_in_direction(&tree, &b.id, FocusDirection::Down),
        Some(c.id.clone())
    );
    assert_eq!(
        pane_in_direction(&tree, &c.id, FocusDirection::Left),
        Some(e.id.clone())
    );
    assert_eq!(
        pane_in_direction(&tree, &e.id, FocusDirection::Right),
        Some(b.id.clone())
    );
    assert_eq!(
        pane_in_direction(&tree, &a.id, FocusDirection::Left),
        Some(e.id.clone())
    );
    let hidden = select_tab(&tree, &a.id);
    assert_eq!(
        pane_in_direction(&hidden, &e.id, FocusDirection::Right),
        Some(a.id.clone())
    );
}

#[test]
fn resizes_a_split_inside_a_split_tab() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let tab_id = tab_id_of(&next, &c.id).unwrap_or_default();
    let sized = set_sizes(&next, &tab_id, &[3.0, 1.0]);
    assert_eq!(
        find_split_tab(&sized, &tab_id).unwrap().sizes,
        vec![3.0, 1.0]
    );
    assert!(set_sizes(&next, "nope", &[1.0]).is_same(&next));
}

#[test]
fn remembers_a_split_tab_neighbour_and_grafts_a_returning_pane_back_into_the_tab() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let beside = placement_of(&next, &c.id);
    assert_eq!(
        beside,
        Some(PanePlacement {
            pane_id: b.id.clone(),
            zone: DropZone::Right,
        })
    );
    let without = close_pane(&next, &c.id);
    let back = graft_node(&mut ids, Some(&without), node(&c), beside.as_ref());
    let rejoined = split_tab_of_pane(&back, &c.id).unwrap();
    assert_eq!(node_ids(&rejoined.children), id_list(&[&b, &c]));
}

#[test]
fn reads_a_split_tab_neighbour_as_a_center_placement_for_a_plain_tab() {
    let mut ids = IdMint::default();
    let (a, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    assert_eq!(
        placement_of(&next, &a.id),
        Some(PanePlacement {
            pane_id: b.id.clone(),
            zone: DropZone::Center,
        })
    );
}

#[test]
fn maps_pane_changes_through_split_tabs_and_returns_the_same_tree_for_no_change() {
    let mut ids = IdMint::default();
    let (_, b, c, root) = stack(&mut ids);
    let next = split_stack(&mut ids, &root, &b, Direction::Horizontal, &c);
    let changed = set_pane_cwd(&next, &c.id, "/x");
    assert!(!changed.is_same(&next));
    assert_eq!(pane_in(&changed, &c.id).cwd.as_deref(), Some("/x"));
    assert!(set_pane_locked(&next, &c.id, false).is_same(&next));
    assert!(without_panes(&next, &|_| false).unwrap().is_same(&next));
}

#[test]
fn counts_a_tab_stack_as_one_slot() {
    let mut ids = IdMint::default();
    let a = pane(&mut ids);
    let b = pane(&mut ids);
    let c = pane(&mut ids);
    assert_eq!(slot_count(&node(&a)), 1);
    let stacked = tabs(&mut ids, &b.id, &[&a, &b]);
    let root = split(&mut ids, Direction::Horizontal, vec![stacked, node(&c)]);
    assert_eq!(slot_count(&root), 2);
}

#[test]
fn sets_every_split_nested_ones_included_to_equal_shares() {
    let mut ids = IdMint::default();
    let first = lone(&mut ids);
    let second = lone(&mut ids);
    let mut inner = split_of(&mut ids, Direction::Vertical, vec![first, second]);
    inner.sizes = vec![3.0, 1.0];
    let third = lone(&mut ids);
    let mut outer = split_of(&mut ids, Direction::Horizontal, vec![third, inner.into()]);
    outer.sizes = vec![5.0, 1.0];
    let next = expect_split(&equalize_sizes(&outer.into()));
    assert_eq!(next.sizes, vec![1.0, 1.0]);
    assert_eq!(expect_split(&next.children[1]).sizes, vec![1.0, 1.0]);
}

#[test]
fn returns_the_same_tree_when_it_is_already_equal() {
    let mut ids = IdMint::default();
    let root = pair(&mut ids, Direction::Horizontal);
    assert!(equalize_sizes(&root).is_same(&root));
}

#[test]
fn returns_a_pane_unchanged() {
    let mut ids = IdMint::default();
    let root = lone(&mut ids);
    assert!(equalize_sizes(&root).is_same(&root));
}
