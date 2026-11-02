use std::sync::Arc;

use super::collapse::is_strip;
use super::tree::{same_nodes, same_tabs};
use super::types::{LayoutNode, PaneNode, SplitNode, SurfaceKind, TabNode, TabsNode};

const MIN_PANEL_FRACTION: f64 = 0.15;
const MAX_PANEL_FRACTION: f64 = 0.85;

#[derive(Clone, Debug, PartialEq)]
pub struct PanelFraction {
    pub key: String,
    pub fraction: f64,
}

pub fn panel_key(pane: &PaneNode) -> Option<String> {
    match pane.kind {
        SurfaceKind::View => pane
            .view_name
            .as_ref()
            .filter(|name| !name.is_empty())
            .map(|name| format!("view:{name}")),
        SurfaceKind::Chat => Some("chat".to_owned()),
        SurfaceKind::Agent => Some("agent".to_owned()),
        SurfaceKind::Git => Some("git".to_owned()),
        _ => None,
    }
}

pub fn clamp_fraction(fraction: f64) -> Option<f64> {
    (fraction.is_finite() && fraction > 0.0)
        .then(|| fraction.clamp(MIN_PANEL_FRACTION, MAX_PANEL_FRACTION))
}

pub fn panel_fractions(split: &SplitNode, sizes: &[f64]) -> Vec<PanelFraction> {
    if sizes.len() != split.children.len() {
        return Vec::new();
    }
    let total: f64 = sizes.iter().sum();
    if total <= 0.0 || total.is_nan() {
        return Vec::new();
    }
    split
        .children
        .iter()
        .zip(sizes)
        .filter_map(|(child, size)| {
            let LayoutNode::Pane(pane) = child else {
                return None;
            };
            let key = panel_key(pane)?;
            let fraction = clamp_fraction(size / total)?;
            Some(PanelFraction { key, fraction })
        })
        .collect()
}

fn parent_split_of(node: &LayoutNode, pane_id: &str) -> Option<Arc<SplitNode>> {
    let LayoutNode::Split(split) = node else {
        return None;
    };
    let direct = split
        .children
        .iter()
        .any(|child| matches!(child, LayoutNode::Pane(pane) if pane.id == pane_id));
    if direct {
        return Some(split.clone());
    }
    split
        .children
        .iter()
        .find_map(|child| parent_split_of(child, pane_id))
}

fn replace_split(node: &LayoutNode, next: &SplitNode) -> LayoutNode {
    let LayoutNode::Split(split) = node else {
        return node.clone();
    };
    if split.id == next.id {
        return next.clone().into();
    }
    let children: Vec<LayoutNode> = split
        .children
        .iter()
        .map(|child| replace_split(child, next))
        .collect();
    if same_nodes(&children, &split.children) {
        return node.clone();
    }
    SplitNode {
        children,
        ..(**split).clone()
    }
    .into()
}

pub fn size_panel(root: &LayoutNode, pane_id: &str, fraction: f64) -> LayoutNode {
    let Some(clamped) = clamp_fraction(fraction) else {
        return root.clone();
    };
    let Some(split) = parent_split_of(root, pane_id).filter(|split| split.children.len() >= 2)
    else {
        return root.clone();
    };
    let Some(at) = split
        .children
        .iter()
        .position(|child| child.id() == pane_id)
    else {
        return root.clone();
    };
    let neighbor = if at > 0 { at - 1 } else { at + 1 };
    let total: f64 = split.sizes.iter().sum();
    let size_at = |index: usize| split.sizes.get(index).copied().unwrap_or(0.0);
    let combined = size_at(at) + size_at(neighbor);
    if total <= 0.0 || combined <= 0.0 || total.is_nan() || combined.is_nan() {
        return root.clone();
    }
    let panel = (clamped * total).min(combined * MAX_PANEL_FRACTION);
    let mut sizes = split.sizes.clone();
    if let Some(entry) = sizes.get_mut(at) {
        *entry = panel;
    }
    if let Some(entry) = sizes.get_mut(neighbor) {
        *entry = combined - panel;
    }
    if sizes == split.sizes {
        return root.clone();
    }
    replace_split(
        root,
        &SplitNode {
            sizes,
            ..(*split).clone()
        },
    )
}

pub fn equalize_sizes(node: &LayoutNode) -> LayoutNode {
    let LayoutNode::Split(split) = node else {
        return node.clone();
    };
    let children: Vec<LayoutNode> = split.children.iter().map(equalize_sizes).collect();
    let same_sizes =
        split.sizes.len() == split.children.len() && split.sizes.iter().all(|size| *size == 1.0);
    if same_nodes(&children, &split.children) && same_sizes {
        return node.clone();
    }
    let sizes = vec![1.0; children.len()];
    SplitNode {
        children,
        sizes,
        ..(**split).clone()
    }
    .into()
}

pub fn set_sizes(root: &LayoutNode, split_id: &str, sizes: &[f64]) -> LayoutNode {
    match root {
        LayoutNode::Pane(_) => root.clone(),
        LayoutNode::Split(split) if split.id == split_id => {
            let kept: Vec<f64> = sizes
                .iter()
                .enumerate()
                .map(|(index, size)| {
                    if split.children.get(index).is_some_and(is_strip) {
                        split.sizes.get(index).copied().unwrap_or(*size)
                    } else {
                        *size
                    }
                })
                .collect();
            if split.sizes == kept {
                return root.clone();
            }
            SplitNode {
                sizes: kept,
                ..(**split).clone()
            }
            .into()
        }
        LayoutNode::Split(split) => {
            let children: Vec<LayoutNode> = split
                .children
                .iter()
                .map(|child| set_sizes(child, split_id, sizes))
                .collect();
            if same_nodes(&children, &split.children) {
                return root.clone();
            }
            SplitNode {
                children,
                ..(**split).clone()
            }
            .into()
        }
        LayoutNode::Tabs(tabs) => {
            let children: Vec<TabNode> = tabs
                .children
                .iter()
                .filter_map(|tab| set_sizes(&tab.to_node(), split_id, sizes).into_tab())
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
    }
}
