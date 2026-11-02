#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NewWorkspacePlacement {
    #[default]
    End,
    Top,
    AfterCurrent,
}

pub trait Orderable {
    fn order_id(&self) -> &str;
    fn is_pinned(&self) -> bool;
}

pub fn insert_index<W: Orderable>(
    list: &[W],
    placement: NewWorkspacePlacement,
    active_id: Option<&str>,
) -> usize {
    let pinned_count = list.iter().filter(|item| item.is_pinned()).count();
    match placement {
        NewWorkspacePlacement::Top => pinned_count,
        NewWorkspacePlacement::End => list.len(),
        NewWorkspacePlacement::AfterCurrent => list
            .iter()
            .position(|item| Some(item.order_id()) == active_id)
            .map_or(list.len(), |at| (at + 1).max(pinned_count)),
    }
}
