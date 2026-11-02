use std::collections::HashMap;

use crate::ids::{IdMint, IdNamespace};
use crate::layout::collapse::settle_collapse;
use crate::layout::pane_fields::{has_locked_pane, set_pane_cwd, set_pane_locked, set_pane_title};
use crate::layout::panel_size::{equalize_sizes, set_sizes};
use crate::layout::tab_focus::{focus_after_close, show_after_close};
use crate::layout::tree::{
    TERMINAL_TITLE, add_tab, close_pane, create_terminal_pane, find_pane, first_pane_id, pane_ids,
    select_tab, slot_count, split_pane, tabs_of_pane,
};
use crate::layout::types::{Direction, LayoutNode, PaneNode, TabNode};
use crate::panes::tab_history::TabHistories;

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceLayout {
    pub root: LayoutNode,
    pub active_pane_id: String,
    pub zoomed_pane_id: Option<String>,
    pub equalized: Option<u64>,
}

pub fn layout_of(root: LayoutNode) -> WorkspaceLayout {
    WorkspaceLayout {
        active_pane_id: first_pane_id(&root).to_owned(),
        root,
        zoomed_pane_id: None,
        equalized: None,
    }
}

pub fn successor_of(before: &LayoutNode, after: &LayoutNode, closed_id: &str) -> String {
    if let Some(tabs) = tabs_of_pane(before, closed_id) {
        let stack = LayoutNode::Tabs(tabs);
        let survivor = close_pane(&stack, closed_id);
        if !survivor.is_same(&stack) {
            return first_pane_id(&survivor).to_owned();
        }
    }
    first_pane_id(after).to_owned()
}

#[derive(Clone, Debug, Default)]
pub struct LayoutStore {
    by_workspace: HashMap<String, WorkspaceLayout>,
    ids: IdMint,
    histories: TabHistories,
    equalize_on_split: bool,
}

impl LayoutStore {
    pub fn new(namespace: IdNamespace) -> Self {
        Self {
            ids: IdMint::new(namespace),
            ..Self::default()
        }
    }

    pub fn layout(&self, workspace_id: &str) -> Option<&WorkspaceLayout> {
        self.by_workspace.get(workspace_id)
    }

    pub fn workspace_ids(&self) -> impl Iterator<Item = &str> {
        self.by_workspace.keys().map(String::as_str)
    }

    pub fn set_equalize_on_split(&mut self, equalize: bool) {
        self.equalize_on_split = equalize;
    }

    fn new_terminal_pane(&mut self, cwd: Option<&str>) -> PaneNode {
        create_terminal_pane(&mut self.ids, TERMINAL_TITLE, cwd)
    }

    fn patch(
        &mut self,
        workspace_id: &str,
        change: impl FnOnce(&mut IdMint, &TabHistories, &WorkspaceLayout) -> WorkspaceLayout,
    ) -> bool {
        let Some(layout) = self.by_workspace.get(workspace_id) else {
            return false;
        };
        let mut next = change(&mut self.ids, &self.histories, layout);
        let from = layout.active_pane_id.clone();
        let slots_before = slot_count(&layout.root);
        let selected = settle_collapse(&select_tab(&next.root, &next.active_pane_id));
        let equalize = self.equalize_on_split && slot_count(&selected) > slots_before;
        if equalize {
            next.root = equalize_sizes(&selected);
            next.equalized = Some(next.equalized.or(layout.equalized).unwrap_or(0) + 1);
        } else {
            next.root = selected;
            next.equalized = next.equalized.or(layout.equalized);
        }
        let changed = next != *layout;
        self.histories
            .note_activated(workspace_id, &from, &next.active_pane_id);
        self.by_workspace.insert(workspace_id.to_owned(), next);
        changed
    }

    fn change_root(
        &mut self,
        workspace_id: &str,
        change: impl FnOnce(&LayoutNode) -> LayoutNode,
    ) -> bool {
        let Some(layout) = self.by_workspace.get_mut(workspace_id) else {
            return false;
        };
        let root = change(&layout.root);
        if root.is_same(&layout.root) {
            return false;
        }
        layout.root = root;
        true
    }

    pub fn ensure(&mut self, workspace_id: &str, work_dir: Option<&str>) -> Option<String> {
        if self.by_workspace.contains_key(workspace_id) {
            return None;
        }
        let pane = self.new_terminal_pane(work_dir);
        let id = pane.id.clone();
        self.by_workspace
            .insert(workspace_id.to_owned(), layout_of(pane.into()));
        Some(id)
    }

    pub fn split(
        &mut self,
        workspace_id: &str,
        pane_id: &str,
        direction: Direction,
        work_dir: Option<&str>,
    ) -> Option<String> {
        let pane = self.new_terminal_pane(None);
        let mut created = None;
        self.patch(workspace_id, |ids, _, layout| {
            let result = split_pane(ids, &layout.root, pane_id, direction, pane);
            created = result.new_pane_id;
            let root = match (&created, work_dir) {
                (Some(new_pane), Some(work_dir)) => set_pane_cwd(&result.root, new_pane, work_dir),
                _ => result.root,
            };
            WorkspaceLayout {
                root,
                active_pane_id: created
                    .clone()
                    .unwrap_or_else(|| layout.active_pane_id.clone()),
                ..layout.clone()
            }
        });
        created
    }

    pub fn new_terminal_tab(
        &mut self,
        workspace_id: &str,
        pane_id: &str,
        work_dir: Option<&str>,
    ) -> Option<String> {
        let layout = self.by_workspace.get(workspace_id)?;
        find_pane(&layout.root, pane_id)?;
        let pane = self.new_terminal_pane(work_dir);
        let created = pane.id.clone();
        self.patch(workspace_id, |ids, _, layout| WorkspaceLayout {
            root: add_tab(ids, &layout.root, pane_id, TabNode::from(pane), false),
            active_pane_id: created.clone(),
            zoomed_pane_id: None,
            equalized: layout.equalized,
        });
        self.histories.note_opener(workspace_id, &created, pane_id);
        Some(created)
    }

    pub fn set_locked(&mut self, workspace_id: &str, pane_id: &str, locked: bool) -> bool {
        self.change_root(workspace_id, |root| set_pane_locked(root, pane_id, locked))
    }

    pub fn is_locked(&self, workspace_id: &str, pane_id: Option<&str>) -> bool {
        let Some(layout) = self.by_workspace.get(workspace_id) else {
            return false;
        };
        match pane_id {
            Some(pane_id) => find_pane(&layout.root, pane_id).is_some_and(|pane| pane.locked),
            None => has_locked_pane(&layout.root),
        }
    }

    pub fn close_pane(&mut self, workspace_id: &str, pane_id: &str) -> bool {
        if self.is_locked(workspace_id, Some(pane_id)) {
            return false;
        }
        let Some(current) = self.by_workspace.get(workspace_id) else {
            return false;
        };
        if matches!(&current.root, LayoutNode::Pane(pane) if pane.id == pane_id) {
            self.by_workspace.remove(workspace_id);
            return true;
        }
        let mut removed = false;
        self.patch(workspace_id, |_, histories, layout| {
            let shown = focus_after_close(&layout.root, pane_id, &histories.of(workspace_id));
            let root = show_after_close(&close_pane(&layout.root, pane_id), shown.as_deref());
            removed =
                find_pane(&layout.root, pane_id).is_some() && find_pane(&root, pane_id).is_none();
            let active_pane_id = if removed && pane_id == layout.active_pane_id {
                shown.unwrap_or_else(|| successor_of(&layout.root, &root, pane_id))
            } else {
                layout.active_pane_id.clone()
            };
            let zoomed_pane_id = layout
                .zoomed_pane_id
                .clone()
                .filter(|zoomed| !(removed && zoomed == pane_id));
            WorkspaceLayout {
                root,
                active_pane_id,
                zoomed_pane_id,
                equalized: layout.equalized,
            }
        });
        if removed {
            self.histories.forget_tab(workspace_id, pane_id);
        }
        removed
    }

    pub fn focus_pane(&mut self, workspace_id: &str, pane_id: &str) -> bool {
        self.patch(workspace_id, |_, _, layout| WorkspaceLayout {
            active_pane_id: pane_id.to_owned(),
            ..layout.clone()
        })
    }

    pub fn zoom_pane(&mut self, workspace_id: &str, pane_id: &str, zoom: Option<bool>) -> bool {
        self.patch(workspace_id, |_, _, layout| {
            let is_zoomed = layout.zoomed_pane_id.as_deref() == Some(pane_id);
            let zoomed_pane_id = match zoom {
                None if is_zoomed => None,
                None | Some(true) => Some(pane_id.to_owned()),
                Some(false) if is_zoomed => None,
                Some(false) => layout.zoomed_pane_id.clone(),
            };
            WorkspaceLayout {
                zoomed_pane_id,
                ..layout.clone()
            }
        })
    }

    pub fn resize(&mut self, workspace_id: &str, split_id: &str, sizes: &[f64]) -> bool {
        self.patch(workspace_id, |_, _, layout| WorkspaceLayout {
            root: set_sizes(&layout.root, split_id, sizes),
            ..layout.clone()
        })
    }

    pub fn set_title(&mut self, workspace_id: &str, pane_id: &str, title: &str) -> bool {
        self.change_root(workspace_id, |root| set_pane_title(root, pane_id, title))
    }

    pub fn set_cwd(&mut self, workspace_id: &str, pane_id: &str, cwd: &str) -> bool {
        self.change_root(workspace_id, |root| set_pane_cwd(root, pane_id, cwd))
    }

    pub fn remove_workspace(&mut self, workspace_id: &str) -> Vec<String> {
        self.histories.forget_workspace_tabs(workspace_id);
        self.by_workspace
            .remove(workspace_id)
            .map(|layout| pane_ids(&layout.root))
            .unwrap_or_default()
    }
}
