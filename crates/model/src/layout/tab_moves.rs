use std::collections::HashSet;

use super::tree::{
    add_tab, all_panes, find_pane, first_pane_id, first_tab_pane_id, focus_id_of, pane_ids,
    place_beside, replace_slot, slot_id_of, split_of, split_tab_of_pane, tab_index, tab_neighbor,
    tab_source, tabs_of, tabs_of_pane, untab, without_panes,
};
use super::types::{Direction, DropZone, LayoutNode, PanePlacement, SplitNode, TabNode, TabsNode};
use crate::ids::IdMint;

fn moving_ids(tab: &TabNode) -> HashSet<String> {
    pane_ids(&tab.to_node()).into_iter().collect()
}

fn zone_axis(zone: DropZone) -> Direction {
    if matches!(zone, DropZone::Left | DropZone::Right) {
        Direction::Horizontal
    } else {
        Direction::Vertical
    }
}

fn zone_is_before(zone: DropZone) -> bool {
    matches!(zone, DropZone::Left | DropZone::Top)
}

pub fn move_pane(
    ids: &mut IdMint,
    root: &LayoutNode,
    source_id: &str,
    target_id: &str,
    zone: DropZone,
) -> LayoutNode {
    let Some(source) = tab_source(root, source_id) else {
        return root.clone();
    };
    if find_pane(root, target_id).is_none() || find_pane(&source.to_node(), target_id).is_some() {
        return root.clone();
    }
    let moving = moving_ids(&source);
    let Some(detached) = without_panes(root, &|pane| moving.contains(&pane.id)) else {
        return root.clone();
    };
    if zone == DropZone::Center {
        let same_stack = tabs_of_pane(root, target_id)
            .is_some_and(|tabs| tabs.children.iter().any(|child| child.id() == source_id));
        if same_stack {
            return root.clone();
        }
        return add_tab(ids, &detached, target_id, source, false);
    }
    place_beside(
        ids,
        &detached,
        target_id,
        untab(&source.to_node()),
        zone_axis(zone),
        zone_is_before(zone),
    )
}

fn parent_of(node: &LayoutNode, child_id: &str) -> Option<std::sync::Arc<SplitNode>> {
    match node {
        LayoutNode::Pane(_) => None,
        LayoutNode::Split(split) => {
            let direct = split
                .children
                .iter()
                .any(|child| !matches!(child, LayoutNode::Split(_)) && child.id() == child_id);
            if direct {
                return Some(split.clone());
            }
            split
                .children
                .iter()
                .find_map(|child| parent_of(child, child_id))
        }
        LayoutNode::Tabs(tabs) => tabs
            .children
            .iter()
            .find_map(|child| parent_of(&child.to_node(), child_id)),
    }
}

fn last_pane_id(node: &LayoutNode) -> String {
    all_panes(node)
        .last()
        .map(|pane| pane.id.clone())
        .unwrap_or_default()
}

pub fn placement_of(root: &LayoutNode, pane_id: &str) -> Option<PanePlacement> {
    let tabs = tabs_of_pane(root, pane_id);
    let at = tabs.as_ref().and_then(|tabs| tab_index(tabs, pane_id));
    let tab = tabs
        .as_ref()
        .zip(at)
        .and_then(|(tabs, at)| tabs.children.get(at));
    if let (Some(tabs), Some(at), Some(TabNode::Pane(_))) = (&tabs, at, tab) {
        let neighbor = at
            .checked_sub(1)
            .and_then(|before| tabs.children.get(before))
            .or_else(|| tabs.children.get(at + 1))?;
        return Some(PanePlacement {
            pane_id: first_tab_pane_id(neighbor).to_owned(),
            zone: DropZone::Center,
        });
    }
    let anchor_id = if tab.is_some() {
        pane_id.to_owned()
    } else {
        slot_id_of(root, pane_id)?
    };
    let parent = parent_of(root, &anchor_id)?;
    let index = parent
        .children
        .iter()
        .position(|child| !matches!(child, LayoutNode::Split(_)) && child.id() == anchor_id)?;
    let horizontal = parent.direction == Direction::Horizontal;
    if let Some(before) = index.checked_sub(1).and_then(|at| parent.children.get(at)) {
        return Some(PanePlacement {
            pane_id: last_pane_id(before),
            zone: if horizontal {
                DropZone::Right
            } else {
                DropZone::Bottom
            },
        });
    }
    Some(PanePlacement {
        pane_id: first_pane_id(parent.children.get(index + 1)?).to_owned(),
        zone: if horizontal {
            DropZone::Left
        } else {
            DropZone::Top
        },
    })
}

fn tabs_of_slot(node: &LayoutNode) -> Option<Vec<TabNode>> {
    match node {
        LayoutNode::Pane(pane) => Some(vec![TabNode::Pane(pane.clone())]),
        LayoutNode::Tabs(tabs) => Some(tabs.children.clone()),
        LayoutNode::Split(_) => None,
    }
}

pub fn graft_node(
    ids: &mut IdMint,
    root: Option<&LayoutNode>,
    node: LayoutNode,
    beside: Option<&PanePlacement>,
) -> LayoutNode {
    let Some(root) = root else {
        return node;
    };
    let Some(anchor) = beside.filter(|anchor| find_pane(root, &anchor.pane_id).is_some()) else {
        return split_of(ids, Direction::Horizontal, vec![root.clone(), node]).into();
    };
    if anchor.zone == DropZone::Center
        && let Some(tabs) = tabs_of_slot(&node)
    {
        let mut next = root.clone();
        let mut after = anchor.pane_id.clone();
        for tab in tabs {
            let shown = first_tab_pane_id(&tab).to_owned();
            next = add_tab(ids, &next, &after, tab, false);
            after = shown;
        }
        return next;
    }
    let zone = if anchor.zone == DropZone::Center {
        DropZone::Right
    } else {
        anchor.zone
    };
    place_beside(
        ids,
        root,
        &anchor.pane_id,
        node,
        zone_axis(zone),
        zone_is_before(zone),
    )
}

pub fn move_tab(
    ids: &mut IdMint,
    root: &LayoutNode,
    source_id: &str,
    target_id: &str,
    after: bool,
) -> LayoutNode {
    let (Some(source), Some(target_pane_id)) =
        (tab_source(root, source_id), focus_id_of(root, target_id))
    else {
        return root.clone();
    };
    if source_id == target_id || find_pane(&source.to_node(), &target_pane_id).is_some() {
        return root.clone();
    }
    let shown_id =
        focus_id_of(root, source_id).unwrap_or_else(|| first_tab_pane_id(&source).to_owned());
    let same_stack = tabs_of_pane(root, &target_pane_id)
        .is_some_and(|tabs| tabs.children.iter().any(|child| child.is_same(&source)));
    let moving = moving_ids(&source);
    let base = if same_stack {
        Some(root.clone())
    } else {
        without_panes(root, &|pane| moving.contains(&pane.id))
    };
    let Some(base) = base else {
        return root.clone();
    };
    let Some(slot_id) = slot_id_of(&base, &target_pane_id) else {
        return root.clone();
    };
    replace_slot(&base, &slot_id, |slot, _, _| {
        let current: Vec<TabNode> = match slot {
            LayoutNode::Tabs(tabs) => tabs.children.clone(),
            other => other.clone().into_tab().into_iter().collect(),
        };
        let mut tabs: Vec<TabNode> = current
            .into_iter()
            .filter(|child| !child.is_same(&source))
            .collect();
        let at = tabs
            .iter()
            .position(|child| match child {
                TabNode::Pane(pane) => pane.id == target_pane_id,
                TabNode::Split(_) => find_pane(&child.to_node(), &target_pane_id).is_some(),
            })
            .unwrap_or(0);
        tabs.insert(if after { at + 1 } else { at }, source);
        match slot {
            LayoutNode::Tabs(existing) => TabsNode {
                children: tabs,
                active_id: shown_id,
                ..(**existing).clone()
            }
            .into(),
            _ => tabs_of(ids, &shown_id, tabs).into(),
        }
    })
}

#[derive(Clone, Debug)]
pub struct TakenTab {
    pub tab: TabNode,
    pub rest: Option<LayoutNode>,
    pub successor: Option<String>,
}

pub fn take_tab(root: &LayoutNode, id: &str) -> Option<TakenTab> {
    let tab = tab_source(root, id)?;
    let moving = moving_ids(&tab);
    let Some(rest) = without_panes(root, &|pane| moving.contains(&pane.id)) else {
        return Some(TakenTab {
            tab,
            rest: None,
            successor: None,
        });
    };
    let split = match &tab {
        TabNode::Pane(pane) => split_tab_of_pane(root, &pane.id),
        TabNode::Split(_) => None,
    };
    let sibling = split.and_then(|split| {
        pane_ids(&LayoutNode::Split(split))
            .into_iter()
            .find(|pane_id| !moving.contains(pane_id))
    });
    let first = first_tab_pane_id(&tab);
    let neighbor = sibling
        .or_else(|| tab_neighbor(root, first, -1))
        .or_else(|| tab_neighbor(root, first, 1));
    let successor = neighbor
        .and_then(|neighbor| focus_id_of(&rest, &neighbor))
        .unwrap_or_else(|| first_pane_id(&rest).to_owned());
    Some(TakenTab {
        tab,
        rest: Some(rest),
        successor: Some(successor),
    })
}

pub fn land_tab(
    ids: &mut IdMint,
    root: Option<&LayoutNode>,
    tab: TabNode,
    anchor_id: &str,
) -> LayoutNode {
    let Some(root) = root else {
        return untab(&tab.to_node());
    };
    let target = if find_pane(root, anchor_id).is_some() {
        anchor_id.to_owned()
    } else {
        first_pane_id(root).to_owned()
    };
    add_tab(ids, root, &target, tab, false)
}
