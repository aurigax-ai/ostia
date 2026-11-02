use super::layout_store::LayoutStore;
use super::workspaces_store::WorkspacesStore;
use crate::layout::types::Direction;

pub fn close_workspace(
    workspaces: &mut WorkspacesStore,
    layouts: &mut LayoutStore,
    id: &str,
) -> bool {
    if layouts.is_locked(id, None) {
        return false;
    }
    layouts.remove_workspace(id);
    workspaces.remove(id)
}

pub fn ensure_terminal(
    workspaces: &WorkspacesStore,
    layouts: &mut LayoutStore,
    id: &str,
) -> Option<String> {
    workspaces.workspace(id)?;
    layouts.ensure(id, workspaces.work_dir_of(id))
}

pub fn split_active_pane(
    workspaces: &WorkspacesStore,
    layouts: &mut LayoutStore,
    direction: Direction,
) -> Option<String> {
    let id = workspaces.active_workspace_id()?;
    let pane = layouts.layout(id)?.active_pane_id.clone();
    layouts.split(id, &pane, direction, workspaces.work_dir_of(id))
}

pub fn new_tab_or_terminal(
    workspaces: &WorkspacesStore,
    layouts: &mut LayoutStore,
) -> Option<String> {
    let id = workspaces.active_workspace_id()?;
    let Some(pane) = layouts
        .layout(id)
        .map(|layout| layout.active_pane_id.clone())
    else {
        return ensure_terminal(workspaces, layouts, id);
    };
    layouts.new_terminal_tab(id, &pane, workspaces.work_dir_of(id))
}
