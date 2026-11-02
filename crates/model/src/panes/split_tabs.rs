use crate::layout::{Direction, LayoutNode, SplitNode};

const SEGMENT_MIN_WIDTH: f64 = 480.0;
const MIN_READABLE_COLUMNS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitTabLayout {
    SideBySide,
    Stacked,
    Grid,
}

pub fn split_tab_layout(tab: &SplitNode) -> SplitTabLayout {
    if tab
        .children
        .iter()
        .any(|child| !matches!(child, LayoutNode::Pane(_)))
    {
        return SplitTabLayout::Grid;
    }
    match tab.direction {
        Direction::Horizontal => SplitTabLayout::SideBySide,
        Direction::Vertical => SplitTabLayout::Stacked,
    }
}

pub fn readable_columns(width: f64) -> usize {
    ((width / SEGMENT_MIN_WIDTH).floor() as usize).max(MIN_READABLE_COLUMNS)
}
