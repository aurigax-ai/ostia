#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::layout::types::DropZone;
use ostia_model::panes::drop_zone::{
    DragEnd, DropTargetSlot, PaneDropTarget, Rect, ScreenPoint, TabDrop, Viewport,
    cell_drop_target, drop_zone_at, ended_outside, pane_drop_target, tab_drop_target,
};

fn pane() -> Rect {
    Rect {
        left: 100.0,
        top: 50.0,
        width: 800.0,
        height: 1000.0,
    }
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn target(id: &str, zone: DropZone) -> Option<PaneDropTarget> {
    Some(PaneDropTarget {
        target_id: id.to_owned(),
        zone,
    })
}

fn drop_at(id: &str, after: bool) -> TabDrop {
    TabDrop {
        target_id: id.to_owned(),
        after,
    }
}

#[test]
fn adds_a_tab_in_the_middle_of_the_pane() {
    assert_eq!(drop_zone_at(&pane(), 500.0, 550.0), DropZone::Center);
}

#[test]
fn splits_toward_each_edge_inside_its_band_measured_on_the_pane_frame() {
    assert_eq!(drop_zone_at(&pane(), 150.0, 550.0), DropZone::Left);
    assert_eq!(drop_zone_at(&pane(), 860.0, 550.0), DropZone::Right);
    assert_eq!(drop_zone_at(&pane(), 500.0, 100.0), DropZone::Top);
    assert_eq!(drop_zone_at(&pane(), 500.0, 1000.0), DropZone::Bottom);
}

#[test]
fn reaches_the_bottom_of_a_tall_pane_not_only_its_top_half() {
    assert_eq!(drop_zone_at(&pane(), 500.0, 700.0), DropZone::Center);
    assert_eq!(drop_zone_at(&pane(), 500.0, 800.0), DropZone::Bottom);
}

#[test]
fn resolves_a_corner_to_the_nearer_edge() {
    assert_eq!(drop_zone_at(&pane(), 110.0, 120.0), DropZone::Left);
    assert_eq!(drop_zone_at(&pane(), 180.0, 60.0), DropZone::Top);
    assert_eq!(drop_zone_at(&pane(), 895.0, 1045.0), DropZone::Bottom);
}

#[test]
fn keeps_a_center_and_four_edges_on_a_tiny_pane() {
    let tiny = Rect {
        left: 0.0,
        top: 0.0,
        width: 60.0,
        height: 60.0,
    };
    assert_eq!(drop_zone_at(&tiny, 30.0, 30.0), DropZone::Center);
    assert_eq!(drop_zone_at(&tiny, 5.0, 30.0), DropZone::Left);
    assert_eq!(drop_zone_at(&tiny, 55.0, 30.0), DropZone::Right);
    assert_eq!(drop_zone_at(&tiny, 30.0, 58.0), DropZone::Bottom);
}

#[test]
fn treats_a_point_outside_the_frame_as_its_nearest_edge_and_a_0x0_frame_as_center() {
    assert_eq!(drop_zone_at(&pane(), 20.0, 550.0), DropZone::Left);
    let empty = Rect {
        left: 0.0,
        top: 0.0,
        width: 0.0,
        height: 0.0,
    };
    assert_eq!(drop_zone_at(&empty, 0.0, 0.0), DropZone::Center);
}

fn stack() -> DropTargetSlot {
    DropTargetSlot {
        tab_ids: ids(&["a", "b"]),
        shown_id: "b".to_owned(),
    }
}

#[test]
fn targets_the_shown_tab_when_the_dragged_pane_comes_from_elsewhere() {
    assert_eq!(
        pane_drop_target(&stack(), Some("x"), DropZone::Right),
        target("b", DropZone::Right)
    );
    assert_eq!(
        pane_drop_target(&stack(), None, DropZone::Center),
        target("b", DropZone::Center)
    );
}

#[test]
fn splits_a_tab_out_of_its_own_stack_beside_the_rest_of_the_stack() {
    assert_eq!(
        pane_drop_target(&stack(), Some("b"), DropZone::Left),
        target("a", DropZone::Left)
    );
}

#[test]
fn does_nothing_when_a_tab_is_dropped_back_in_the_middle_of_its_own_stack() {
    assert_eq!(
        pane_drop_target(&stack(), Some("b"), DropZone::Center),
        None
    );
}

#[test]
fn does_nothing_when_a_lone_pane_is_dropped_on_itself() {
    let lone = DropTargetSlot {
        tab_ids: ids(&["a"]),
        shown_id: "a".to_owned(),
    };
    assert_eq!(pane_drop_target(&lone, Some("a"), DropZone::Right), None);
}

#[test]
fn drops_after_the_last_tab_when_the_strip_is_hovered_past_the_tabs() {
    assert_eq!(
        tab_drop_target(&ids(&["a", "b"]), Some("x"), None),
        Some(drop_at("b", true))
    );
}

#[test]
fn reorders_within_a_stack_and_ignores_drops_that_keep_the_order() {
    let abc = ids(&["a", "b", "c"]);
    assert_eq!(
        tab_drop_target(&abc, Some("a"), Some(drop_at("c", true))),
        Some(drop_at("c", true))
    );
    assert_eq!(
        tab_drop_target(&abc, Some("a"), Some(drop_at("b", false))),
        None
    );
    assert_eq!(
        tab_drop_target(&ids(&["a", "b"]), Some("a"), Some(drop_at("a", true))),
        None
    );
    assert_eq!(tab_drop_target(&ids(&["a"]), Some("a"), None), None);
}

fn viewport() -> Viewport {
    Viewport {
        width: 1280.0,
        height: 800.0,
    }
}

fn end(drop_effect: &str, origin: (f64, f64), point: (f64, f64)) -> DragEnd {
    DragEnd {
        drop_effect: drop_effect.to_owned(),
        point: ScreenPoint {
            x: point.0,
            y: point.1,
        },
        origin: ScreenPoint {
            x: origin.0,
            y: origin.1,
        },
    }
}

#[test]
fn is_true_when_the_drag_ended_outside_the_window() {
    assert!(ended_outside(
        &end("none", (160.0, 100.0), (1500.0, 400.0)),
        &viewport()
    ));
    assert!(ended_outside(
        &end("none", (160.0, 100.0), (400.0, 60.0)),
        &viewport()
    ));
}

#[test]
fn is_false_for_a_cancel_or_a_refused_drop_inside_the_window() {
    assert!(!ended_outside(
        &end("none", (160.0, 100.0), (500.0, 400.0)),
        &viewport()
    ));
}

#[test]
fn measures_the_end_point_in_the_drags_own_coordinates_not_the_window_position() {
    assert!(!ended_outside(
        &end("none", (0.0, 0.0), (310.0, 46.0)),
        &viewport()
    ));
}

#[test]
fn is_false_when_something_accepted_the_drop() {
    assert!(!ended_outside(
        &end("move", (160.0, 100.0), (1500.0, 400.0)),
        &viewport()
    ));
}

#[test]
fn targets_the_cell_on_every_zone_for_a_pane_from_elsewhere() {
    let stack = ids(&["a", "split-1"]);
    assert_eq!(
        cell_drop_target("c", &stack, Some("x"), DropZone::Left),
        target("c", DropZone::Left)
    );
    assert_eq!(
        cell_drop_target("c", &stack, Some("x"), DropZone::Center),
        target("c", DropZone::Center)
    );
}

#[test]
fn refuses_a_drop_on_the_cell_itself_and_a_center_drop_of_a_tab_of_the_same_stack() {
    let stack = ids(&["a", "split-1"]);
    assert_eq!(
        cell_drop_target("c", &stack, Some("c"), DropZone::Right),
        None
    );
    assert_eq!(
        cell_drop_target("c", &stack, Some("a"), DropZone::Center),
        None
    );
    assert_eq!(
        cell_drop_target("c", &stack, Some("a"), DropZone::Bottom),
        target("c", DropZone::Bottom)
    );
}

#[test]
fn lets_a_sibling_segment_be_pulled_out_into_its_own_tab_with_a_center_drop() {
    let stack = ids(&["a", "split-1"]);
    assert_eq!(
        cell_drop_target("c", &stack, Some("b"), DropZone::Center),
        target("c", DropZone::Center)
    );
}

#[test]
fn treats_an_empty_source_id_as_no_source() {
    assert_eq!(
        pane_drop_target(&stack(), Some(""), DropZone::Center),
        target("b", DropZone::Center)
    );
}

#[test]
fn drops_nowhere_on_an_empty_strip_with_nothing_hovered() {
    assert_eq!(tab_drop_target(&[], Some("x"), None), None);
}

#[test]
fn treats_a_drag_end_exactly_on_the_viewport_edge_as_outside_and_on_the_origin_as_inside() {
    assert!(ended_outside(
        &end("none", (0.0, 0.0), (1280.0, 10.0)),
        &viewport()
    ));
    assert!(ended_outside(
        &end("none", (0.0, 0.0), (10.0, 800.0)),
        &viewport()
    ));
    assert!(!ended_outside(
        &end("none", (0.0, 0.0), (0.0, 0.0)),
        &viewport()
    ));
    assert!(ended_outside(
        &end("none", (0.0, 0.0), (-1.0, 0.0)),
        &viewport()
    ));
}
