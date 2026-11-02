use std::collections::HashMap;

use super::tree::{select_tab, tab_index, tabs_of_pane};
use super::types::{LayoutNode, TabNode};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TabHistory {
    pub recent: Vec<String>,
    pub openers: HashMap<String, String>,
}

pub fn focus_after_close(
    root: &LayoutNode,
    closed_id: &str,
    history: &TabHistory,
) -> Option<String> {
    let tabs = tabs_of_pane(root, closed_id)?;
    if tabs.active_id != closed_id {
        return None;
    }
    let closed_at = tab_index(&tabs, closed_id)?;
    if !matches!(tabs.children.get(closed_at), Some(TabNode::Pane(_))) {
        return None;
    }
    let usable = |id: &String| tab_index(&tabs, id).is_some_and(|at| at != closed_at);
    if let Some(opener) = history.openers.get(closed_id).filter(|id| usable(id)) {
        return Some(opener.clone());
    }
    history.recent.iter().find(|id| usable(id)).cloned()
}

pub fn show_after_close(root: &LayoutNode, shown_id: Option<&str>) -> LayoutNode {
    shown_id.map_or_else(|| root.clone(), |id| select_tab(root, id))
}
