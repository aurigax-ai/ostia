use std::collections::HashSet;
use std::sync::Arc;

use super::tree::{
    all_panes, find_pane, find_split_tab, find_split_tab_by_name, first_pane_id, insert_tab,
    is_pane_shown, pane_ids, replace_slot, replace_tab, select_tab, split_of, split_tab_of_pane,
    tabs_of_pane, without_panes,
};
use super::types::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode, TabsNode};
use crate::ids::IdMint;

const HOLD_ID: &str = "split-tab-hold";

fn row_counts(count: usize, columns: f64) -> Vec<usize> {
    let per_row = columns.floor().max(1.0) as usize;
    if count <= per_row {
        return vec![count];
    }
    let rows = count.div_ceil(per_row);
    let base = count / rows;
    let extra = count % rows;
    (0..rows)
        .map(|index| base + usize::from(index < extra))
        .collect()
}

fn shape_of(node: &LayoutNode) -> String {
    match node {
        LayoutNode::Pane(pane) => pane.id.clone(),
        LayoutNode::Tabs(tabs) => format!("tabs:{}", tabs.id),
        LayoutNode::Split(split) => {
            let sizes: Vec<String> = split.sizes.iter().map(f64::to_string).collect();
            let children: Vec<String> = split.children.iter().map(shape_of).collect();
            format!(
                "{}:{:?}[{}]({})",
                split.id,
                split.direction,
                sizes.join(","),
                children.join(" ")
            )
        }
    }
}

fn as_nodes(panes: &[Arc<PaneNode>]) -> Vec<LayoutNode> {
    panes.iter().cloned().map(LayoutNode::Pane).collect()
}

pub fn arrange_split_tab(
    ids: &mut IdMint,
    panes: &[Arc<PaneNode>],
    columns: f64,
    name: Option<&str>,
    current: Option<&Arc<SplitNode>>,
) -> Arc<SplitNode> {
    let counts = row_counts(panes.len(), columns);
    let old_rows: Vec<&Arc<SplitNode>> = current
        .filter(|split| split.direction == Direction::Vertical)
        .map(|split| {
            split
                .children
                .iter()
                .filter_map(|child| match child {
                    LayoutNode::Split(row) => Some(row),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut at = 0;
    let mut rows = Vec::with_capacity(counts.len());
    for (index, count) in counts.iter().enumerate() {
        let line = &panes[at..at + count];
        at += count;
        if let [only] = line {
            rows.push(LayoutNode::Pane(only.clone()));
            continue;
        }
        let mut row = split_of(ids, Direction::Horizontal, as_nodes(line));
        if let Some(old) = old_rows.get(index) {
            row.id = old.id.clone();
        }
        rows.push(row.into());
    }
    let outer = if counts.len() == 1 {
        split_of(ids, Direction::Horizontal, as_nodes(panes))
    } else {
        split_of(ids, Direction::Vertical, rows)
    };
    let arranged = SplitNode {
        id: current.map_or(outer.id.clone(), |split| split.id.clone()),
        name: name.map(str::to_owned),
        folded: current.is_some_and(|split| split.folded),
        ..outer
    };
    if let Some(current) = current
        && current.name.as_deref() == name
        && shape_of(&LayoutNode::Split(current.clone()))
            == shape_of(&LayoutNode::Split(Arc::new(arranged.clone())))
    {
        return current.clone();
    }
    Arc::new(arranged)
}

struct Near {
    id: String,
    after: bool,
}

fn place_near(root: &LayoutNode, anchor_id: &str, moving: &HashSet<String>) -> Option<Near> {
    let stack = tabs_of_pane(root, anchor_id)?;
    let at = stack
        .children
        .iter()
        .position(|child| pane_ids(&child.to_node()).iter().any(|id| id == anchor_id))?;
    let survivor = |tab: &TabNode| {
        pane_ids(&tab.to_node())
            .into_iter()
            .find(|id| !moving.contains(id))
    };
    if let Some(id) = stack.children[..=at].iter().rev().find_map(survivor) {
        return Some(Near { id, after: true });
    }
    stack.children[at + 1..]
        .iter()
        .find_map(survivor)
        .map(|id| Near { id, after: false })
}

fn place_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    tab: &Arc<SplitNode>,
    moving: &HashSet<String>,
) -> Option<LayoutNode> {
    let is_moving = |pane: &PaneNode| moving.contains(&pane.id);
    let tab_node = LayoutNode::Split(tab.clone());
    let anchor = pane_ids(&tab_node).into_iter().next().unwrap_or_default();
    if let Some(near) = place_near(root, &anchor, moving) {
        let hold = PaneNode::new(HOLD_ID, "", SurfaceKind::Terminal);
        let inserted = insert_tab(ids, root, &near.id, hold.into(), near.after);
        if let Some(held) = without_panes(&inserted, &is_moving)
            && tabs_of_pane(&held, HOLD_ID).is_some()
        {
            return Some(replace_tab(&held, HOLD_ID, |_| TabNode::Split(tab.clone())));
        }
    }
    let rest = without_panes(root, &is_moving)?;
    let first = first_pane_id(&rest).to_owned();
    Some(insert_tab(
        ids,
        &rest,
        &first,
        TabNode::Split(tab.clone()),
        true,
    ))
}

fn untabbed(tab: &SplitNode) -> SplitNode {
    SplitNode {
        name: None,
        ..tab.clone()
    }
}

pub fn join_split_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    joining_ids: &[String],
    name: &str,
    columns: f64,
    partner_id: Option<&str>,
) -> LayoutNode {
    let existing = find_split_tab_by_name(root, name);
    let members = existing
        .as_ref()
        .map(|tab| all_panes(&LayoutNode::Split(tab.clone())))
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let joining: Vec<Arc<PaneNode>> = joining_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter(|id| !members.iter().any(|pane| pane.id == **id))
        .filter_map(|id| find_pane(root, id))
        .collect();
    if joining.is_empty() {
        return root.clone();
    }
    let partner = partner_id
        .filter(|id| existing.is_none() && !joining.iter().any(|pane| pane.id == *id))
        .and_then(|id| find_pane(root, id));
    let panes: Vec<Arc<PaneNode>> = members.into_iter().chain(partner).chain(joining).collect();
    if panes.len() < 2 {
        return root.clone();
    }
    let moving: HashSet<String> = panes.iter().map(|pane| pane.id.clone()).collect();
    let tab = arrange_split_tab(ids, &panes, columns, Some(name), existing.as_ref());
    let Some(placed) = place_tab(ids, root, &tab, &moving) else {
        return untabbed(&tab).into();
    };
    match panes.iter().find(|pane| is_pane_shown(root, &pane.id)) {
        Some(shown) => select_tab(&placed, &shown.id),
        None => placed,
    }
}

pub fn separate_from_split_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    leaving_ids: &[String],
    columns: f64,
) -> LayoutNode {
    let mut next = root.clone();
    let mut seen = HashSet::new();
    for id in leaving_ids.iter().filter(|id| seen.insert(id.as_str())) {
        let (Some(tab), Some(pane)) = (split_tab_of_pane(&next, id), find_pane(&next, id)) else {
            continue;
        };
        let Some(stay) = pane_ids(&LayoutNode::Split(tab.clone()))
            .into_iter()
            .find(|other| other != id)
        else {
            continue;
        };
        let Some(rest) = without_panes(&next, &|candidate| candidate.id == *id) else {
            continue;
        };
        let arranged = if find_split_tab(&rest, &tab.id).is_some() {
            replace_tab(&rest, &tab.id, |current| match current {
                TabNode::Split(split) => {
                    let panes = all_panes(&LayoutNode::Split(split.clone()));
                    TabNode::Split(arrange_split_tab(
                        ids,
                        &panes,
                        columns,
                        split.name.as_deref(),
                        Some(split),
                    ))
                }
                other => other.clone(),
            })
        } else {
            rest
        };
        next = insert_tab(ids, &arranged, &stay, TabNode::Pane(pane), true);
    }
    next
}

fn expanded_pane(pane: &Arc<PaneNode>) -> Arc<PaneNode> {
    if !pane.collapsed {
        return pane.clone();
    }
    let mut next = (**pane).clone();
    next.collapsed = false;
    Arc::new(next)
}

pub fn split_tab_to_tabs(root: &LayoutNode, split_tab_id: &str) -> LayoutNode {
    let Some(tab) = find_split_tab(root, split_tab_id) else {
        return root.clone();
    };
    let tab_node = LayoutNode::Split(tab.clone());
    let Some(tabs) = tabs_of_pane(root, first_pane_id(&tab_node)) else {
        return root.clone();
    };
    let members: Vec<TabNode> = all_panes(&tab_node)
        .iter()
        .map(|pane| TabNode::Pane(expanded_pane(pane)))
        .collect();
    let children: Vec<TabNode> = tabs
        .children
        .iter()
        .flat_map(|child| match child {
            TabNode::Split(split) if Arc::ptr_eq(split, &tab) => members.clone(),
            other => vec![other.clone()],
        })
        .collect();
    let next = TabsNode {
        children,
        ..(*tabs).clone()
    };
    replace_slot(root, &tabs.id, |_, _, _| next.into())
}
