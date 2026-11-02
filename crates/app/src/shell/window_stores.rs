use gpui_kit::prelude::*;
use gpui_kit::{App, Entity};
use ostia_model::ids::IdNamespace;
use ostia_model::layout::types::Direction;
use ostia_model::workspaces::actions::{
    close_workspace as close_workspace_in, new_tab_or_terminal, split_active_pane,
};
use ostia_model::workspaces::layout_store::LayoutStore;
use ostia_model::workspaces::workspace_order::NewWorkspacePlacement;
use ostia_model::workspaces::workspaces_store::{WorkspaceKind, WorkspacesStore};

use super::store::{Store, change_both, change_reading};

const NEW_WORKSPACE_DIR: &str = "~";

#[derive(Clone)]
pub struct WindowStores {
    pub workspaces: Entity<Store<WorkspacesStore>>,
    pub layouts: Entity<Store<LayoutStore>>,
}

impl WindowStores {
    pub fn new(namespace: &IdNamespace, cx: &mut App) -> Self {
        Self {
            workspaces: cx.new(|_| Store::new(WorkspacesStore::new(namespace.clone()))),
            layouts: cx.new(|_| Store::new(LayoutStore::new(namespace.clone()))),
        }
    }

    pub fn new_workspace(&self, cx: &mut App) {
        self.workspaces.update(cx, |store, cx| {
            store.change(cx, |workspaces| {
                workspaces.add_workspace(
                    NEW_WORKSPACE_DIR,
                    NewWorkspacePlacement::default(),
                    WorkspaceKind::default(),
                );
                true
            })
        });
    }

    pub fn select_workspace(&self, id: &str, cx: &mut App) {
        self.workspaces.update(cx, |store, cx| {
            store.change(cx, |workspaces| workspaces.set_active(id))
        });
    }

    pub fn close_workspace(&self, id: &str, cx: &mut App) {
        change_both(
            &self.workspaces,
            &self.layouts,
            cx,
            |workspaces, layouts| close_workspace_in(workspaces, layouts, id),
        );
    }

    pub fn close_active_workspace(&self, cx: &mut App) {
        let active = self
            .workspaces
            .read(cx)
            .state()
            .active_workspace_id()
            .map(str::to_owned);
        if let Some(active) = active {
            self.close_workspace(&active, cx);
        }
    }

    pub fn new_terminal(&self, cx: &mut App) {
        change_reading(
            &self.workspaces,
            &self.layouts,
            cx,
            |workspaces, layouts| new_tab_or_terminal(workspaces, layouts).is_some(),
        );
    }

    pub fn split_active(&self, direction: Direction, cx: &mut App) {
        change_reading(
            &self.workspaces,
            &self.layouts,
            cx,
            |workspaces, layouts| split_active_pane(workspaces, layouts, direction).is_some(),
        );
    }

    pub fn close_active_pane(&self, cx: &mut App) {
        let target = {
            let workspaces = self.workspaces.read(cx).state();
            let layouts = self.layouts.read(cx).state();
            workspaces.active_workspace_id().and_then(|workspace| {
                layouts
                    .layout(workspace)
                    .map(|layout| (workspace.to_owned(), layout.active_pane_id.clone()))
            })
        };
        if let Some((workspace, pane)) = target {
            self.close_pane(&workspace, &pane, cx);
        }
    }

    pub fn close_pane(&self, workspace: &str, pane: &str, cx: &mut App) {
        self.layouts.update(cx, |store, cx| {
            store.change(cx, |layouts| layouts.close_pane(workspace, pane))
        });
    }

    pub fn focus_pane(&self, workspace: &str, pane: &str, cx: &mut App) {
        self.layouts.update(cx, |store, cx| {
            store.change(cx, |layouts| layouts.focus_pane(workspace, pane))
        });
    }
}
