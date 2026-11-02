#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::ids::IdMint;
use ostia_model::layout::pane_fields::{set_pane_chat, set_pane_view};
use ostia_model::layout::panel_size::{
    PanelFraction, clamp_fraction, panel_fractions, panel_key, set_sizes, size_panel,
};
use ostia_model::layout::tree::{create_pane, split_of, split_pane};
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind};

fn kind_pane(ids: &mut IdMint, kind: SurfaceKind) -> LayoutNode {
    create_pane(ids, kind, None, None).into()
}

fn terminal(ids: &mut IdMint) -> LayoutNode {
    kind_pane(ids, SurfaceKind::Terminal)
}

fn view_pane(ids: &mut IdMint, name: &str) -> LayoutNode {
    let pane = kind_pane(ids, SurfaceKind::View);
    set_pane_view(&pane, pane.id(), name, "Panel")
}

fn pane_arc(node: &LayoutNode) -> Arc<PaneNode> {
    let LayoutNode::Pane(pane) = node else {
        panic!("not a pane")
    };
    pane.clone()
}

fn split_arc(node: &LayoutNode) -> Arc<SplitNode> {
    let LayoutNode::Split(split) = node else {
        panic!("not a split")
    };
    split.clone()
}

fn sizes_of(root: &LayoutNode) -> Vec<f64> {
    split_arc(root).sizes.clone()
}

fn sized_split(
    ids: &mut IdMint,
    direction: Direction,
    children: Vec<LayoutNode>,
    sizes: Vec<f64>,
) -> LayoutNode {
    let mut split = split_of(ids, direction, children);
    split.sizes = sizes;
    split.into()
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() < 1e-9
}

#[test]
fn names_a_view_and_the_chat_pane_by_what_they_show() {
    let mut ids = IdMint::default();
    let view = kind_pane(&mut ids, SurfaceKind::View);
    let chat = kind_pane(&mut ids, SurfaceKind::Chat);
    let named = set_pane_view(&view, view.id(), "deploys", "Deploys");
    assert_eq!(
        panel_key(&pane_arc(&named)).as_deref(),
        Some("view:deploys")
    );
    let chatting = set_pane_chat(&chat, chat.id(), "Chat", None);
    assert_eq!(panel_key(&pane_arc(&chatting)).as_deref(), Some("chat"));
}

#[test]
fn gives_no_key_to_terminals_editors_and_browsers() {
    let mut ids = IdMint::default();
    for kind in [
        SurfaceKind::Terminal,
        SurfaceKind::Editor,
        SurfaceKind::Browser,
    ] {
        assert_eq!(panel_key(&pane_arc(&kind_pane(&mut ids, kind))), None);
    }
}

#[test]
fn keeps_a_fraction_inside_0_15_to_0_85() {
    assert_eq!(clamp_fraction(0.3), Some(0.3));
    assert_eq!(clamp_fraction(0.02), Some(0.15));
    assert_eq!(clamp_fraction(0.99), Some(0.85));
}

#[test]
fn refuses_a_fraction_that_is_not_a_positive_number() {
    assert_eq!(clamp_fraction(0.0), None);
    assert_eq!(clamp_fraction(f64::NAN), None);
    assert_eq!(clamp_fraction(f64::INFINITY), None);
}

#[test]
fn reports_the_panel_share_of_its_split_from_the_dragged_sizes() {
    let mut ids = IdMint::default();
    let plain = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let split = split_of(&mut ids, Direction::Horizontal, vec![plain, panel]);
    assert_eq!(
        panel_fractions(&split, &[900.0, 300.0]),
        vec![PanelFraction {
            key: "view:deploys".to_owned(),
            fraction: 0.25
        }]
    );
}

#[test]
fn ignores_panels_inside_nested_splits_and_panes_without_a_key() {
    let mut ids = IdMint::default();
    let panel = view_pane(&mut ids, "deploys");
    let plain = terminal(&mut ids);
    let nested = sized_split(
        &mut ids,
        Direction::Vertical,
        vec![panel, plain],
        vec![1.0, 1.0],
    );
    let first = terminal(&mut ids);
    let split = split_of(&mut ids, Direction::Horizontal, vec![first, nested]);
    assert_eq!(panel_fractions(&split, &[600.0, 600.0]), Vec::new());
}

#[test]
fn clamps_a_panel_dragged_almost_shut() {
    let mut ids = IdMint::default();
    let plain = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let split = split_of(&mut ids, Direction::Horizontal, vec![plain, panel]);
    assert_eq!(
        panel_fractions(&split, &[990.0, 10.0]),
        vec![PanelFraction {
            key: "view:deploys".to_owned(),
            fraction: 0.15
        }]
    );
}

#[test]
fn reports_nothing_when_the_sizes_do_not_match_the_children() {
    let mut ids = IdMint::default();
    let plain = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let split = split_of(&mut ids, Direction::Horizontal, vec![plain, panel]);
    assert_eq!(panel_fractions(&split, &[1000.0]), Vec::new());
}

#[test]
fn gives_a_new_panel_its_remembered_fraction_of_a_two_pane_split() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let added = create_pane(&mut ids, SurfaceKind::Terminal, None, None);
    let result = split_pane(&mut ids, &root, root.id(), Direction::Horizontal, added);
    let next = size_panel(&result.root, &result.new_pane_id.unwrap(), 0.3);
    let sizes = sizes_of(&next);
    assert!(close(sizes[0], 1.4));
    assert!(close(sizes[1], 0.6));
}

#[test]
fn takes_the_room_from_the_pane_it_was_split_from_leaving_other_children_alone() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let root = sized_split(
        &mut ids,
        Direction::Horizontal,
        vec![a, b, panel.clone()],
        vec![400.0, 400.0, 400.0],
    );
    let next = size_panel(&root, panel.id(), 0.25);
    assert_eq!(sizes_of(&next), vec![400.0, 500.0, 300.0]);
}

#[test]
fn never_lets_the_panel_crowd_out_the_pane_beside_it() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let root = sized_split(
        &mut ids,
        Direction::Horizontal,
        vec![a, b, panel.clone()],
        vec![800.0, 200.0, 200.0],
    );
    let next = size_panel(&root, panel.id(), 0.85);
    let sizes = sizes_of(&next);
    assert_eq!(sizes[0], 800.0);
    assert!(close(sizes[2], 340.0));
    assert!(close(sizes[1], 60.0));
}

#[test]
fn returns_the_same_root_when_the_pane_is_not_a_direct_child_of_a_split() {
    let mut ids = IdMint::default();
    let lone = terminal(&mut ids);
    assert!(size_panel(&lone, lone.id(), 0.3).is_same(&lone));
}

#[test]
fn returns_the_same_root_when_the_size_already_matches() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let panel = view_pane(&mut ids, "deploys");
    let root = sized_split(
        &mut ids,
        Direction::Horizontal,
        vec![a, panel.clone()],
        vec![700.0, 300.0],
    );
    assert!(size_panel(&root, panel.id(), 0.3).is_same(&root));
}

#[test]
fn reaches_a_panel_inside_a_nested_split() {
    let mut ids = IdMint::default();
    let panel = view_pane(&mut ids, "deploys");
    let plain = terminal(&mut ids);
    let inner = sized_split(
        &mut ids,
        Direction::Horizontal,
        vec![plain, panel.clone()],
        vec![1.0, 1.0],
    );
    let first = terminal(&mut ids);
    let root = split_of(&mut ids, Direction::Vertical, vec![first.clone(), inner]);
    let root: LayoutNode = root.into();
    let next = size_panel(&root, panel.id(), 0.2);
    let next_split = split_arc(&next);
    assert!(next_split.children[0].is_same(&first));
    let inner_next = split_arc(&next_split.children[1]);
    assert!(close(inner_next.sizes[1], 0.4));
}

#[test]
fn set_sizes_returns_the_same_tree_when_the_split_already_has_those_sizes() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let inner = split_of(&mut ids, Direction::Vertical, vec![a, b]);
    let inner_id = inner.id.clone();
    let first = terminal(&mut ids);
    let root: LayoutNode =
        split_of(&mut ids, Direction::Horizontal, vec![first, inner.into()]).into();
    assert!(set_sizes(&root, &inner_id, &[1.0, 1.0]).is_same(&root));
    assert!(!set_sizes(&root, &inner_id, &[1.0, 2.0]).is_same(&root));
    assert!(!set_sizes(&root, &inner_id, &[1.0, 1.0, 1.0]).is_same(&root));
}

#[test]
fn replaces_the_sizes_of_a_nested_split_addressed_by_id() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let inner = split_of(&mut ids, Direction::Vertical, vec![a, b]);
    let inner_id = inner.id.clone();
    let first = terminal(&mut ids);
    let root: LayoutNode =
        split_of(&mut ids, Direction::Horizontal, vec![first, inner.into()]).into();
    let next = set_sizes(&root, &inner_id, &[0.3, 0.7]);
    let inner_next = split_arc(&split_arc(&next).children[1]);
    assert_eq!(inner_next.sizes, vec![0.3, 0.7]);
}

#[test]
fn updates_the_root_split_when_its_own_id_matches() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root: LayoutNode = split_of(&mut ids, Direction::Horizontal, vec![a, b]).into();
    let next = set_sizes(&root, root.id(), &[2.0, 5.0]);
    assert_eq!(sizes_of(&next), vec![2.0, 5.0]);
}

#[test]
fn leaves_sizes_unchanged_when_no_split_id_matches() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root: LayoutNode = split_of(&mut ids, Direction::Horizontal, vec![a, b]).into();
    let next = set_sizes(&root, "ghost", &[9.0, 9.0]);
    assert_eq!(sizes_of(&next), vec![1.0, 1.0]);
}

#[test]
fn returns_a_lone_root_pane_unchanged() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    assert!(set_sizes(&root, "any", &[1.0]).is_same(&root));
}
