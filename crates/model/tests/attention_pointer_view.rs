#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::attention::pointer_view::{POINTER_VIEW_MS, PointerView};

#[test]
fn counts_a_pane_as_pointed_at_only_while_the_pointer_moved_over_it_recently() {
    let view = PointerView::default();
    view.point_at_pane("a", 1000);
    assert!(view.is_pane_pointed_at("a", 1000 + POINTER_VIEW_MS));
    assert!(!view.is_pane_pointed_at("a", 1001 + POINTER_VIEW_MS));
    assert!(!view.is_pane_pointed_at("b", 1000));
}

#[test]
fn forgets_a_pane_the_pointer_left_but_not_when_another_pane_is_the_one_pointed_at() {
    let view = PointerView::default();
    view.point_at_pane("a", 1000);
    view.leave_pane("b");
    assert!(view.is_pane_pointed_at("a", 1000));
    view.leave_pane("a");
    assert!(!view.is_pane_pointed_at("a", 1000));
}

#[test]
fn points_at_one_pane_at_a_time() {
    let view = PointerView::default();
    view.point_at_pane("a", 1000);
    view.point_at_pane("b", 2000);
    assert!(!view.is_pane_pointed_at("a", 2000));
    assert!(view.is_pane_pointed_at("b", 2000));
}

#[test]
fn forgets_the_pointed_pane_on_reset() {
    let view = PointerView::default();
    view.point_at_pane("a", 1000);
    view.reset();
    assert!(!view.is_pane_pointed_at("a", 1000));
}

#[test]
fn shares_the_pointed_pane_between_clones() {
    let view = PointerView::default();
    let other = view.clone();
    view.point_at_pane("a", 1000);
    assert!(other.is_pane_pointed_at("a", 1000));
}
