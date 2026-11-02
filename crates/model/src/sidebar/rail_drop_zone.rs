#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowDropZone {
    Before,
    After,
    Merge,
    Tab,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RailDragKind {
    Workspace,
    Tab,
}

const MERGE_ZONE_EDGE: f64 = 0.3;

pub fn row_drop_zone(kind: RailDragKind, fraction: f64, accepts: bool) -> Option<RowDropZone> {
    if kind == RailDragKind::Tab {
        return accepts.then_some(RowDropZone::Tab);
    }
    if !accepts {
        return Some(if fraction < 0.5 {
            RowDropZone::Before
        } else {
            RowDropZone::After
        });
    }
    Some(if fraction < MERGE_ZONE_EDGE {
        RowDropZone::Before
    } else if fraction > 1.0 - MERGE_ZONE_EDGE {
        RowDropZone::After
    } else {
        RowDropZone::Merge
    })
}
