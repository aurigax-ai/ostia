use crate::stores::app::settings_model::NewWorkspacePlacement;

pub trait Orderable {
    fn id(&self) -> &str;
    fn pinned(&self) -> bool;
    fn set_pinned_flag(&mut self, pinned: bool);
}

pub fn insert_index<W: Orderable>(
    list: &[W],
    placement: NewWorkspacePlacement,
    active_id: Option<&str>,
) -> usize {
    let pinned_count = list.iter().filter(|item| item.pinned()).count();
    match placement {
        NewWorkspacePlacement::Top => pinned_count,
        NewWorkspacePlacement::End => list.len(),
        NewWorkspacePlacement::AfterCurrent => list
            .iter()
            .position(|item| Some(item.id()) == active_id)
            .map_or(list.len(), |at| (at + 1).max(pinned_count)),
    }
}

pub fn with_pinned<W: Orderable>(mut workspace: W, pinned: bool) -> W {
    if workspace.pinned() != pinned {
        workspace.set_pinned_flag(pinned);
    }
    workspace
}

pub fn set_pinned<W: Orderable + Clone>(list: Vec<W>, id: &str, pinned: bool) -> Vec<W> {
    let Some(current) = list.iter().find(|item| item.id() == id).cloned() else {
        return list;
    };
    if current.pinned() == pinned {
        return list;
    }
    let others: Vec<W> = list.into_iter().filter(|item| item.id() != id).collect();
    let pinned_count = others.iter().filter(|item| item.pinned()).count();
    let mut result = others;
    let rest = result.split_off(pinned_count);
    result.push(with_pinned(current, pinned));
    result.extend(rest);
    result
}
