#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::sidebar::rail_drop_zone::{RailDragKind, RowDropZone, row_drop_zone};

#[test]
fn splits_a_row_into_reorder_halves_when_the_dragged_workspace_cannot_merge_into_it() {
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.1, false),
        Some(RowDropZone::Before)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.5, false),
        Some(RowDropZone::After)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.9, false),
        Some(RowDropZone::After)
    );
}

#[test]
fn keeps_the_edges_for_reordering_and_the_middle_for_merging_when_it_can_merge() {
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.1, true),
        Some(RowDropZone::Before)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.5, true),
        Some(RowDropZone::Merge)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.9, true),
        Some(RowDropZone::After)
    );
}

#[test]
fn gives_a_dragged_tab_the_whole_row_when_the_workspace_takes_it_and_nothing_otherwise() {
    for fraction in [0.1, 0.5, 0.9] {
        assert_eq!(
            row_drop_zone(RailDragKind::Tab, fraction, true),
            Some(RowDropZone::Tab),
            "fraction {fraction}"
        );
        assert_eq!(
            row_drop_zone(RailDragKind::Tab, fraction, false),
            None,
            "fraction {fraction}"
        );
    }
}

#[test]
fn treats_the_merge_zone_edges_as_merge_and_the_edge_of_a_non_merging_row_as_after() {
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.3, true),
        Some(RowDropZone::Merge)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.7, true),
        Some(RowDropZone::Merge)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 0.0, true),
        Some(RowDropZone::Before)
    );
    assert_eq!(
        row_drop_zone(RailDragKind::Workspace, 1.0, true),
        Some(RowDropZone::After)
    );
}
