use std::sync::Arc;

use crate::ids::IdMint;
use crate::layout::tab_join::join_split_tab;
use crate::layout::tree::{
    add_tab, all_panes, find_pane, find_split_tab, find_split_tab_by_name, pane_ids,
    split_tab_of_pane, tab_id_of,
};
use crate::layout::types::{LayoutNode, PaneNode, TabNode};
use crate::panes::agent_split_tabs::AgentSplitTabs;
use crate::panes::split_tab_seeds::SplitTabSeeds;
use crate::panes::split_tabs::readable_columns;

pub fn split_tab_partner(
    seeds: &SplitTabSeeds,
    workspace_id: &str,
    root: &LayoutNode,
    name: &str,
) -> Option<String> {
    let seed = seeds.split_tab_seed(workspace_id, name)?;
    let loose = find_pane(root, &seed).is_some() && split_tab_of_pane(root, &seed).is_none();
    loose.then_some(seed)
}

pub fn mark_new_split_tab(
    agents: &AgentSplitTabs,
    before: &LayoutNode,
    after: &LayoutNode,
    name: &str,
) {
    let Some(made) = find_split_tab_by_name(after, name) else {
        return;
    };
    if find_split_tab(before, &made.id).is_none() {
        agents.mark_agent_split_tab(&made.id);
    }
}

pub fn split_tab_anchor(
    seeds: &SplitTabSeeds,
    agents: &AgentSplitTabs,
    workspace_id: &str,
    root: &LayoutNode,
    name: &str,
) -> Option<String> {
    let Some(named) = find_split_tab_by_name(root, name) else {
        return split_tab_partner(seeds, workspace_id, root, name);
    };
    if !agents.is_agent_split_tab(&named.id) {
        return None;
    }
    all_panes(&LayoutNode::Split(named))
        .last()
        .map(|pane| pane.id.clone())
}

pub fn joined_terminal(
    ids: &mut IdMint,
    root: &LayoutNode,
    anchor: &str,
    pane: Arc<PaneNode>,
    name: &str,
    columns: f64,
) -> LayoutNode {
    let with_pane = add_tab(ids, root, anchor, TabNode::Pane(pane.clone()), true);
    let partner = find_split_tab_by_name(root, name)
        .is_none()
        .then_some(anchor);
    join_split_tab(
        ids,
        &with_pane,
        std::slice::from_ref(&pane.id),
        name,
        columns,
        partner,
    )
}

pub fn tab_columns(width: f64) -> f64 {
    readable_columns(width) as f64
}

pub fn tab_membership(root: &LayoutNode, pane_id: &str) -> String {
    let tab = tab_id_of(root, pane_id).unwrap_or_else(|| "null".to_owned());
    let name = split_tab_of_pane(root, pane_id)
        .and_then(|split| split.name.clone())
        .unwrap_or_default();
    format!("{tab}:{name}")
}

pub fn forget_dragged(seeds: &SplitTabSeeds, root: Option<&LayoutNode>, source_id: &str) {
    let Some(root) = root else {
        return;
    };
    let source = find_pane(root, source_id)
        .map(LayoutNode::Pane)
        .or_else(|| find_split_tab(root, source_id).map(LayoutNode::Split));
    if let Some(source) = source {
        seeds.forget_split_tab_seeds(pane_ids(&source));
    }
}
