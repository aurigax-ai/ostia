#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::ids::IdMint;
use ostia_model::layout::focus_direction::{FocusDirection, keyboard_pane_id, pane_in_direction};
use ostia_model::layout::tree::{create_pane, pane_ids, split_of, tabs_of};
use ostia_model::layout::types::{Direction, LayoutNode, SurfaceKind, TabNode};

fn terminal(ids: &mut IdMint) -> LayoutNode {
    create_pane(ids, SurfaceKind::Terminal, None, None).into()
}

fn titled(ids: &mut IdMint, title: &str) -> LayoutNode {
    create_pane(ids, SurfaceKind::Terminal, Some(title), None).into()
}

fn split(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> LayoutNode {
    split_of(ids, direction, children).into()
}

fn tab(node: &LayoutNode) -> TabNode {
    node.clone().into_tab().unwrap()
}

fn tabs(ids: &mut IdMint, active: &str, children: &[&LayoutNode]) -> LayoutNode {
    tabs_of(ids, active, children.iter().map(|node| tab(node)).collect()).into()
}

fn grid(ids: &mut IdMint) -> LayoutNode {
    let left = titled(ids, "left");
    let top_right = titled(ids, "top-right");
    let bottom_right = titled(ids, "bottom-right");
    let right = split(ids, Direction::Vertical, vec![top_right, bottom_right]);
    split(ids, Direction::Horizontal, vec![left, right])
}

fn toward(root: &LayoutNode, id: &str, direction: FocusDirection) -> Option<String> {
    pane_in_direction(root, id, direction)
}

fn at(root: &LayoutNode, active: &str, zoomed: Option<&str>) -> String {
    keyboard_pane_id(root, active, zoomed)
}

#[test]
fn returns_the_pane_that_shares_the_edge_in_the_asked_direction() {
    let mut ids = IdMint::default();
    let root = grid(&mut ids);
    let all = pane_ids(&root);
    let (left, top_right, bottom_right) = (&all[0], &all[1], &all[2]);
    assert_eq!(
        toward(&root, left, FocusDirection::Right).as_ref(),
        Some(top_right)
    );
    assert_eq!(
        toward(&root, top_right, FocusDirection::Down).as_ref(),
        Some(bottom_right)
    );
    assert_eq!(
        toward(&root, bottom_right, FocusDirection::Up).as_ref(),
        Some(top_right)
    );
    assert_eq!(
        toward(&root, bottom_right, FocusDirection::Left).as_ref(),
        Some(left)
    );
}

#[test]
fn returns_none_at_the_outer_edge_and_for_a_lone_pane() {
    let mut ids = IdMint::default();
    let root = grid(&mut ids);
    let all = pane_ids(&root);
    assert_eq!(toward(&root, &all[0], FocusDirection::Left), None);
    assert_eq!(toward(&root, &all[1], FocusDirection::Up), None);
    let lone = terminal(&mut ids);
    assert_eq!(toward(&lone, lone.id(), FocusDirection::Right), None);
}

#[test]
fn follows_split_sizes_and_picks_the_neighbour_nearest_the_middle_of_the_pane() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let d = terminal(&mut ids);
    let mut right = split_of(&mut ids, Direction::Vertical, vec![b, c.clone(), d]);
    right.sizes = vec![2.0, 1.0, 1.0];
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![a.clone(), right.into()],
    );
    assert_eq!(
        toward(&root, a.id(), FocusDirection::Right).as_deref(),
        Some(c.id())
    );
}

#[test]
fn moves_to_the_shown_tab_of_a_tab_stack_and_from_any_tab_of_one() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let t1 = terminal(&mut ids);
    let t2 = terminal(&mut ids);
    let stack = tabs(&mut ids, t2.id(), &[&t1, &t2]);
    let root = split(&mut ids, Direction::Horizontal, vec![a.clone(), stack]);
    assert_eq!(
        toward(&root, a.id(), FocusDirection::Right).as_deref(),
        Some(t2.id())
    );
    assert_eq!(
        toward(&root, t1.id(), FocusDirection::Left).as_deref(),
        Some(a.id())
    );
}

#[test]
fn is_the_active_pane_while_the_layout_holds_it() {
    let mut ids = IdMint::default();
    let left = terminal(&mut ids);
    let right = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![left, right.clone()]);
    assert_eq!(at(&root, right.id(), None), right.id());
}

#[test]
fn is_the_last_active_pane_of_a_split_tab() {
    let mut ids = IdMint::default();
    let solo = terminal(&mut ids);
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let inner = split(&mut ids, Direction::Vertical, vec![a, b.clone()]);
    let root = tabs(&mut ids, b.id(), &[&solo, &inner]);
    assert_eq!(at(&root, b.id(), None), b.id());
}

#[test]
fn falls_back_to_the_top_left_pane_of_the_shown_tab_when_the_active_pane_is_gone() {
    let mut ids = IdMint::default();
    let solo = terminal(&mut ids);
    let top_left = terminal(&mut ids);
    let top_right = terminal(&mut ids);
    let bottom = terminal(&mut ids);
    let top = split(
        &mut ids,
        Direction::Horizontal,
        vec![top_left.clone(), top_right],
    );
    let split_tab = split(&mut ids, Direction::Vertical, vec![top, bottom.clone()]);
    let shown = tabs(&mut ids, bottom.id(), &[&solo, &split_tab]);
    assert_eq!(at(&shown, "gone", None), top_left.id());
    let solo_shown = tabs(&mut ids, solo.id(), &[&solo, &split_tab]);
    assert_eq!(at(&solo_shown, "gone", None), solo.id());
}

#[test]
fn reads_the_top_left_slot_first_when_the_root_is_split_into_slots() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let c = terminal(&mut ids);
    let stack = tabs(&mut ids, b.id(), &[&a, &b]);
    let root = split(&mut ids, Direction::Horizontal, vec![stack, c]);
    assert_eq!(at(&root, "gone", None), b.id());
}

#[test]
fn is_the_zoomed_pane_while_one_is_zoomed() {
    let mut ids = IdMint::default();
    let left = terminal(&mut ids);
    let right = terminal(&mut ids);
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![left.clone(), right.clone()],
    );
    assert_eq!(at(&root, left.id(), Some(right.id())), right.id());
}
