#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::layout::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind};
use ostia_model::panes::split_tabs::{SplitTabLayout, readable_columns, split_tab_layout};

fn pane(id: &str) -> LayoutNode {
    LayoutNode::from(PaneNode::new(id, id, SurfaceKind::Terminal))
}

fn nested(id: &str) -> LayoutNode {
    LayoutNode::from(SplitNode {
        id: id.to_string(),
        direction: Direction::Vertical,
        children: vec![pane("n1"), pane("n2")],
        sizes: vec![50.0, 50.0],
        name: None,
        folded: false,
    })
}

fn split(direction: &str, children: Vec<LayoutNode>) -> SplitNode {
    let sizes: Vec<f64> = children.iter().map(|_| 50.0).collect();
    let direction = match direction {
        "horizontal" => Direction::Horizontal,
        "vertical" => Direction::Vertical,
        other => panic!("unknown direction {other}"),
    };
    SplitNode {
        id: "s".to_string(),
        direction,
        children,
        sizes,
        name: None,
        folded: false,
    }
}

#[test]
fn lays_out_side_by_side_when_a_horizontal_split_holds_only_panes() {
    let tab = split("horizontal", vec![pane("a"), pane("b")]);
    assert_eq!(split_tab_layout(&tab), SplitTabLayout::SideBySide);
}

#[test]
fn lays_out_stacked_when_a_vertical_split_holds_only_panes() {
    let tab = split("vertical", vec![pane("a"), pane("b")]);
    assert_eq!(split_tab_layout(&tab), SplitTabLayout::Stacked);
}

#[test]
fn lays_out_a_grid_when_any_child_is_not_a_pane() {
    for direction in ["horizontal", "vertical"] {
        let tab = split(direction, vec![pane("a"), nested("inner")]);
        assert_eq!(
            split_tab_layout(&tab),
            SplitTabLayout::Grid,
            "direction {direction}"
        );
    }
}

#[test]
fn follows_the_direction_when_the_split_has_no_children() {
    assert_eq!(
        split_tab_layout(&split("horizontal", vec![])),
        SplitTabLayout::SideBySide
    );
    assert_eq!(
        split_tab_layout(&split("vertical", vec![])),
        SplitTabLayout::Stacked
    );
}

#[test]
fn gives_at_least_two_readable_columns() {
    for (width, expected) in [(0.0, 2), (479.0, 2), (959.0, 2), (-100.0, 2)] {
        assert_eq!(readable_columns(width), expected, "width {width}");
    }
}

#[test]
fn gives_one_readable_column_for_each_480_units_of_width() {
    for (width, expected) in [
        (960.0, 2),
        (1439.0, 2),
        (1440.0, 3),
        (2400.0, 5),
        (2879.9, 5),
    ] {
        assert_eq!(readable_columns(width), expected, "width {width}");
    }
}
