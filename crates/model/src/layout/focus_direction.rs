use std::collections::HashSet;

use super::tree::{find_pane, pane_ids, shown_tab};
use super::types::LayoutNode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusDirection {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq)]
struct SlotRect {
    pane_id: String,
    shown_ids: Vec<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn slot_rects(node: &LayoutNode, x: f64, y: f64, w: f64, h: f64) -> Vec<SlotRect> {
    match node {
        LayoutNode::Pane(pane) => vec![SlotRect {
            pane_id: pane.id.clone(),
            shown_ids: vec![pane.id.clone()],
            x,
            y,
            w,
            h,
        }],
        LayoutNode::Tabs(tabs) => {
            let Some(tab) = shown_tab(tabs) else {
                return Vec::new();
            };
            let mut rects = slot_rects(&tab.to_node(), x, y, w, h);
            let placed: HashSet<String> = rects
                .iter()
                .flat_map(|rect| rect.shown_ids.iter().cloned())
                .collect();
            let hidden = pane_ids(node).into_iter().filter(|id| !placed.contains(id));
            if let Some(first) = rects.first_mut() {
                first.shown_ids.extend(hidden);
            }
            rects
        }
        LayoutNode::Split(split) => {
            let sum: f64 = split.sizes.iter().sum();
            let total = if sum == 0.0 {
                split.children.len() as f64
            } else {
                sum
            };
            let horizontal = split.direction == super::types::Direction::Horizontal;
            let mut rects = Vec::new();
            let mut offset = 0.0;
            for (index, child) in split.children.iter().enumerate() {
                let share = split.sizes.get(index).copied().unwrap_or(1.0) / total;
                if horizontal {
                    rects.extend(slot_rects(child, x + offset * w, y, share * w, h));
                } else {
                    rects.extend(slot_rects(child, x, y + offset * h, w, share * h));
                }
                offset += share;
            }
            rects
        }
    }
}

const EDGE_EPSILON: f64 = 1e-6;

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    a1.min(b1) - a0.max(b0)
}

pub fn pane_in_direction(
    root: &LayoutNode,
    pane_id: &str,
    direction: FocusDirection,
) -> Option<String> {
    let rects = slot_rects(root, 0.0, 0.0, 1.0, 1.0);
    let from_at = rects
        .iter()
        .position(|rect| rect.shown_ids.iter().any(|id| id == pane_id))?;
    let from = rects.get(from_at)?;
    let horizontal = matches!(direction, FocusDirection::Left | FocusDirection::Right);
    let center = if horizontal {
        from.y + from.h / 2.0
    } else {
        from.x + from.w / 2.0
    };
    let distance = |rect: &SlotRect| {
        if horizontal {
            (rect.y + rect.h / 2.0 - center).abs()
        } else {
            (rect.x + rect.w / 2.0 - center).abs()
        }
    };
    rects
        .iter()
        .enumerate()
        .filter(|(index, rect)| {
            if *index == from_at {
                return false;
            }
            let touches = match direction {
                FocusDirection::Left => (rect.x + rect.w - from.x).abs() < EDGE_EPSILON,
                FocusDirection::Right => (from.x + from.w - rect.x).abs() < EDGE_EPSILON,
                FocusDirection::Up => (rect.y + rect.h - from.y).abs() < EDGE_EPSILON,
                FocusDirection::Down => (from.y + from.h - rect.y).abs() < EDGE_EPSILON,
            };
            let shared = if horizontal {
                overlap(rect.y, rect.y + rect.h, from.y, from.y + from.h)
            } else {
                overlap(rect.x, rect.x + rect.w, from.x, from.x + from.w)
            };
            touches && shared > EDGE_EPSILON
        })
        .map(|(_, rect)| rect)
        .min_by(|a, b| {
            distance(a)
                .partial_cmp(&distance(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|rect| rect.pane_id.clone())
}

fn top_left_shown_pane(node: &LayoutNode) -> String {
    match node {
        LayoutNode::Pane(pane) => pane.id.clone(),
        LayoutNode::Tabs(tabs) => shown_tab(tabs)
            .map(|tab| top_left_shown_pane(&tab.to_node()))
            .unwrap_or_default(),
        LayoutNode::Split(split) => split
            .children
            .first()
            .map(top_left_shown_pane)
            .unwrap_or_default(),
    }
}

pub fn keyboard_pane_id(
    root: &LayoutNode,
    active_pane_id: &str,
    zoomed_pane_id: Option<&str>,
) -> String {
    if let Some(zoomed) = zoomed_pane_id
        && find_pane(root, zoomed).is_some()
    {
        return zoomed.to_owned();
    }
    if find_pane(root, active_pane_id).is_some() {
        return active_pane_id.to_owned();
    }
    top_left_shown_pane(root)
}
