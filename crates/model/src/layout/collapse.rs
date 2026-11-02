use std::sync::Arc;

use super::pane_fields::map_split_panes;
use super::tree::{
    all_panes, find_pane, find_split_tab, first_pane_id, replace_tab, same_nodes, same_tabs,
    select_tab, split_tab_of_pane, tabs_of_pane,
};
use super::types::{Direction, LayoutNode, PaneNode, SplitNode, TabNode, TabsNode};

pub const STRIP_SIZE: f64 = 26.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollapseChange {
    Collapse,
    CollapseOthers,
    ExpandAll,
}

fn expanded(pane: &Arc<PaneNode>) -> Arc<PaneNode> {
    if !pane.collapsed {
        return pane.clone();
    }
    let mut next = (**pane).clone();
    next.collapsed = false;
    Arc::new(next)
}

fn collapsed(pane: &Arc<PaneNode>) -> Arc<PaneNode> {
    if pane.collapsed {
        return pane.clone();
    }
    let mut next = (**pane).clone();
    next.collapsed = true;
    Arc::new(next)
}

fn map_tab(
    root: &LayoutNode,
    tab: &SplitNode,
    change: impl FnMut(&Arc<PaneNode>) -> Arc<PaneNode>,
) -> LayoutNode {
    replace_tab(root, &tab.id, |current| match current {
        TabNode::Split(split) => TabNode::Split(map_split_panes(split, change)),
        other => other.clone(),
    })
}

pub fn is_strip(node: &LayoutNode) -> bool {
    match node {
        LayoutNode::Pane(pane) => pane.collapsed,
        LayoutNode::Split(split) => split.children.iter().all(is_strip),
        LayoutNode::Tabs(_) => false,
    }
}

pub fn can_collapse(tab: &Arc<SplitNode>, pane_id: &str) -> bool {
    let panes = all_panes(&LayoutNode::Split(tab.clone()));
    let open: Vec<&Arc<PaneNode>> = panes.iter().filter(|pane| !pane.collapsed).collect();
    open.len() > 1 && open.iter().any(|pane| pane.id == pane_id)
}

pub fn strip_axis(split: &SplitNode, pane_id: &str) -> Option<Direction> {
    split.children.iter().find_map(|child| match child {
        LayoutNode::Pane(pane) if pane.id == pane_id => Some(split.direction),
        LayoutNode::Split(inner) => strip_axis(inner, pane_id),
        _ => None,
    })
}

fn collapse_pane(root: &LayoutNode, pane_id: &str) -> LayoutNode {
    let Some(tab) = split_tab_of_pane(root, pane_id).filter(|tab| can_collapse(tab, pane_id))
    else {
        return root.clone();
    };
    let next = map_tab(root, &tab, |pane| {
        if pane.id == pane_id {
            collapsed(pane)
        } else {
            pane.clone()
        }
    });
    if tabs_of_pane(&next, pane_id).is_none_or(|tabs| tabs.active_id != pane_id) {
        return next;
    }
    let panes = all_panes(&LayoutNode::Split(tab));
    let Some(at) = panes.iter().position(|pane| pane.id == pane_id) else {
        return next;
    };
    let nearest = panes[at + 1..]
        .iter()
        .chain(panes[..at].iter().rev())
        .find(|pane| !pane.collapsed);
    nearest.map_or_else(|| next.clone(), |pane| select_tab(&next, &pane.id))
}

fn collapse_others(root: &LayoutNode, pane_id: &str) -> LayoutNode {
    let Some(tab) = split_tab_of_pane(root, pane_id) else {
        return root.clone();
    };
    let next = map_tab(root, &tab, |pane| {
        if pane.id == pane_id {
            expanded(pane)
        } else {
            collapsed(pane)
        }
    });
    let shown = tabs_of_pane(&next, pane_id).map(|tabs| tabs.active_id.clone());
    let in_tab = shown.is_some_and(|shown| find_pane(&LayoutNode::Split(tab), &shown).is_some());
    if in_tab {
        select_tab(&next, pane_id)
    } else {
        next
    }
}

fn expand_all(root: &LayoutNode, pane_id: &str) -> LayoutNode {
    match split_tab_of_pane(root, pane_id) {
        Some(tab) => map_tab(root, &tab, expanded),
        None => root.clone(),
    }
}

pub fn change_collapse(root: &LayoutNode, pane_id: &str, change: CollapseChange) -> LayoutNode {
    match change {
        CollapseChange::Collapse => collapse_pane(root, pane_id),
        CollapseChange::CollapseOthers => collapse_others(root, pane_id),
        CollapseChange::ExpandAll => expand_all(root, pane_id),
    }
}

fn unfolded(split: Arc<SplitNode>) -> Arc<SplitNode> {
    if !split.folded {
        return split;
    }
    let mut next = (*split).clone();
    next.folded = false;
    Arc::new(next)
}

fn with_children(split: &Arc<SplitNode>, children: Vec<LayoutNode>) -> Arc<SplitNode> {
    if same_nodes(&children, &split.children) {
        return split.clone();
    }
    Arc::new(SplitNode {
        children,
        ..(**split).clone()
    })
}

fn settle_inner(node: &LayoutNode) -> LayoutNode {
    let LayoutNode::Split(split) = node else {
        return node.clone();
    };
    let children = split.children.iter().map(settle_inner).collect();
    let next = unfolded(with_children(split, children));
    if Arc::ptr_eq(&next, split) {
        node.clone()
    } else {
        LayoutNode::Split(next)
    }
}

fn settle_tab(tab: &Arc<SplitNode>, active_id: &str) -> Arc<SplitNode> {
    let panes = all_panes(&LayoutNode::Split(tab.clone()));
    let has_active = panes.iter().any(|pane| pane.id == active_id);
    let keep = panes.iter().find(|pane| pane.id == active_id).or_else(|| {
        panes
            .iter()
            .all(|pane| pane.collapsed)
            .then(|| panes.first())
            .flatten()
    });
    let opened = match keep.filter(|pane| pane.collapsed) {
        Some(keep) => map_split_panes(tab, |pane| {
            if Arc::ptr_eq(pane, keep) {
                expanded(pane)
            } else {
                pane.clone()
            }
        }),
        None => tab.clone(),
    };
    let children = opened.children.iter().map(settle_inner).collect();
    let inner = with_children(&opened, children);
    if has_active { unfolded(inner) } else { inner }
}

pub fn settle_collapse(root: &LayoutNode) -> LayoutNode {
    match root {
        LayoutNode::Pane(pane) => LayoutNode::Pane(expanded(pane)),
        LayoutNode::Tabs(tabs) => {
            let children: Vec<TabNode> = tabs
                .children
                .iter()
                .map(|child| match child {
                    TabNode::Pane(pane) => TabNode::Pane(expanded(pane)),
                    TabNode::Split(split) => TabNode::Split(settle_tab(split, &tabs.active_id)),
                })
                .collect();
            if same_tabs(&children, &tabs.children) {
                return root.clone();
            }
            TabsNode {
                children,
                ..(**tabs).clone()
            }
            .into()
        }
        LayoutNode::Split(split) => {
            let children = split.children.iter().map(settle_collapse).collect();
            let next = unfolded(with_children(split, children));
            if Arc::ptr_eq(&next, split) {
                root.clone()
            } else {
                LayoutNode::Split(next)
            }
        }
    }
}

fn open_pane_of(tab: &TabNode) -> Option<String> {
    match tab {
        TabNode::Pane(pane) => Some(pane.id.clone()),
        TabNode::Split(split) if split.folded => None,
        TabNode::Split(split) => all_panes(&LayoutNode::Split(split.clone()))
            .iter()
            .find(|pane| !pane.collapsed)
            .map(|pane| pane.id.clone()),
    }
}

pub fn fold_split_tab(root: &LayoutNode, tab_id: &str) -> LayoutNode {
    let Some(tab) = find_split_tab(root, tab_id).filter(|tab| !tab.folded) else {
        return root.clone();
    };
    let tab_node = LayoutNode::Split(tab.clone());
    let Some(tabs) = tabs_of_pane(root, first_pane_id(&tab_node)) else {
        return root.clone();
    };
    let folded = replace_tab(root, tab_id, |_| {
        SplitNode {
            folded: true,
            ..(*tab).clone()
        }
        .into()
    });
    if find_pane(&tab_node, &tabs.active_id).is_none() {
        return folded;
    }
    let Some(at) = tabs
        .children
        .iter()
        .position(|child| matches!(child, TabNode::Split(split) if Arc::ptr_eq(split, &tab)))
    else {
        return root.clone();
    };
    let shown = tabs.children[at + 1..]
        .iter()
        .chain(tabs.children[..at].iter().rev())
        .find_map(open_pane_of);
    shown.map_or_else(|| root.clone(), |shown| select_tab(&folded, &shown))
}

pub fn is_tucked(root: &LayoutNode, pane_id: &str) -> bool {
    find_pane(root, pane_id).is_some_and(|pane| pane.collapsed)
        || split_tab_of_pane(root, pane_id).is_some_and(|tab| tab.folded)
}

pub fn strip_sizes(
    sizes: &[f64],
    strips: &[bool],
    total: Option<f64>,
    opened: &[bool],
) -> Vec<f64> {
    let is_strip_at = |index: usize| strips.get(index).copied().unwrap_or(false);
    let is_opened_at = |index: usize| opened.get(index).copied().unwrap_or(false);
    let sum = |keep: &dyn Fn(usize) -> bool| -> f64 {
        sizes
            .iter()
            .enumerate()
            .filter(|(index, _)| keep(*index))
            .map(|(_, size)| *size)
            .sum()
    };
    let stripped = STRIP_SIZE * strips.iter().filter(|strip| **strip).count() as f64;
    let room =
        (total.unwrap_or_else(|| sum(&|index| !is_strip_at(index)) + stripped) - stripped).max(0.0);
    let back = sum(&|index| !is_strip_at(index) && is_opened_at(index));
    let rest = sum(&|index| !is_strip_at(index) && !is_opened_at(index));
    let restored = back < room && rest > 0.0;
    let share = if restored { room - back } else { room };
    let pool = if restored { rest } else { back + rest };
    sizes
        .iter()
        .enumerate()
        .map(|(index, size)| {
            if is_strip_at(index) {
                STRIP_SIZE
            } else if restored && is_opened_at(index) {
                *size
            } else if pool > 0.0 {
                size / pool * share
            } else {
                0.0
            }
        })
        .collect()
}
