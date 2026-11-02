use crate::layout::types::DropZone;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

const EDGE_FRACTION: f64 = 0.28;
const EDGE_MIN_PX: f64 = 48.0;

fn band(size: f64) -> f64 {
    (size * EDGE_FRACTION).max(EDGE_MIN_PX).min(size / 3.0)
}

pub fn drop_zone_at(rect: &Rect, x: f64, y: f64) -> DropZone {
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return DropZone::Center;
    }
    let bx = band(rect.width);
    let by = band(rect.height);
    let dx = (x - rect.left).clamp(0.0, rect.width);
    let dy = (y - rect.top).clamp(0.0, rect.height);
    let reach = [
        (DropZone::Left, dx / bx),
        (DropZone::Right, (rect.width - dx) / bx),
        (DropZone::Top, dy / by),
        (DropZone::Bottom, (rect.height - dy) / by),
    ];
    let mut best = (DropZone::Center, 1.0);
    for candidate in reach {
        if candidate.1 < best.1 {
            best = candidate;
        }
    }
    best.0
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DropTargetSlot {
    pub tab_ids: Vec<String>,
    pub shown_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneDropTarget {
    pub target_id: String,
    pub zone: DropZone,
}

fn present(source_id: Option<&str>) -> Option<&str> {
    source_id.filter(|id| !id.is_empty())
}

pub fn pane_drop_target(
    slot: &DropTargetSlot,
    source_id: Option<&str>,
    zone: DropZone,
) -> Option<PaneDropTarget> {
    let source = present(source_id).filter(|id| slot.tab_ids.iter().any(|t| t == id));
    let Some(source) = source else {
        return Some(PaneDropTarget {
            target_id: slot.shown_id.clone(),
            zone,
        });
    };
    if zone == DropZone::Center {
        return None;
    }
    slot.tab_ids
        .iter()
        .find(|id| id.as_str() != source)
        .map(|other| PaneDropTarget {
            target_id: other.clone(),
            zone,
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabDrop {
    pub target_id: String,
    pub after: bool,
}

pub fn tab_drop_target(
    tab_ids: &[String],
    source_id: Option<&str>,
    hovered: Option<TabDrop>,
) -> Option<TabDrop> {
    let target = hovered.or_else(|| {
        tab_ids.last().map(|last| TabDrop {
            target_id: last.clone(),
            after: true,
        })
    })?;
    let source = present(source_id);
    if source_id == Some(target.target_id.as_str()) {
        return None;
    }
    if let Some(source) = source
        && let Some(from) = tab_ids.iter().position(|id| id == source)
    {
        let target_index = tab_ids.iter().position(|id| *id == target.target_id);
        let to = target_index.map_or(-1, |index| index as i64) + i64::from(target.after);
        let from = from as i64;
        if to == from || to == from + 1 {
            return None;
        }
    }
    Some(target)
}

#[derive(Clone, Debug, PartialEq)]
pub struct DragEnd {
    pub drop_effect: String,
    pub point: ScreenPoint,
    pub origin: ScreenPoint,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}

pub fn ended_outside(end: &DragEnd, viewport: &Viewport) -> bool {
    if end.drop_effect != "none" {
        return false;
    }
    let x = end.point.x - end.origin.x;
    let y = end.point.y - end.origin.y;
    x < 0.0 || y < 0.0 || x >= viewport.width || y >= viewport.height
}

pub fn cell_drop_target(
    cell_id: &str,
    stack_tab_ids: &[String],
    source_id: Option<&str>,
    zone: DropZone,
) -> Option<PaneDropTarget> {
    if source_id == Some(cell_id) {
        return None;
    }
    if zone == DropZone::Center
        && let Some(source) = present(source_id)
        && stack_tab_ids.iter().any(|id| id == source)
    {
        return None;
    }
    Some(PaneDropTarget {
        target_id: cell_id.to_owned(),
        zone,
    })
}
