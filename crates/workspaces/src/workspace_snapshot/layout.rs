use serde_json::Value;

use super::fields::{Record, is_true, text};
use super::model::{
    SnapshotNode, SnapshotSplit, SnapshotTabItem, SnapshotTabs, SplitDirection, SurfaceKind,
};
use super::pane::parse_pane;
use super::{MAX_LAYOUT_DEPTH, MAX_PANES};
use crate::js_json::JsNumber;
use crate::workspace_text::normalize_split_tab_name;

pub enum Parsed {
    Node(SnapshotNode),
    Retired,
    Invalid,
}

pub fn parse_node(raw: &Value, pane_ids: &mut Vec<String>, depth: usize, in_tab: bool) -> Parsed {
    if depth > MAX_LAYOUT_DEPTH {
        return Parsed::Invalid;
    }
    let Some(record) = raw.as_object() else {
        return Parsed::Invalid;
    };
    let Some(id) = text(record, "id").filter(|id| !id.is_empty()) else {
        return Parsed::Invalid;
    };
    match text(record, "type") {
        Some("pane") => parse_pane_node(record, id, pane_ids, in_tab),
        Some("tabs") => parse_tabs(record, id, pane_ids, depth, in_tab),
        Some("split") => parse_split(record, id, pane_ids, depth, in_tab),
        _ => Parsed::Invalid,
    }
}

fn parse_pane_node(record: &Record, id: &str, pane_ids: &mut Vec<String>, in_tab: bool) -> Parsed {
    let Some(kind) = text(record, "kind") else {
        return Parsed::Invalid;
    };
    let Some(kind) = SurfaceKind::parse(kind) else {
        return Parsed::Retired;
    };
    if pane_ids.len() >= MAX_PANES {
        return Parsed::Invalid;
    }
    let Some(pane) = parse_pane(record, id, kind, in_tab) else {
        return Parsed::Invalid;
    };
    pane_ids.push(id.to_owned());
    Parsed::Node(SnapshotNode::Pane(Box::new(pane)))
}

fn parse_tabs(
    record: &Record,
    id: &str,
    pane_ids: &mut Vec<String>,
    depth: usize,
    in_tab: bool,
) -> Parsed {
    if in_tab {
        return Parsed::Invalid;
    }
    let Some(children) = record
        .get("children")
        .and_then(Value::as_array)
        .filter(|children| !children.is_empty())
    else {
        return Parsed::Invalid;
    };
    let mut tabs = Vec::new();
    for child in children {
        let Some(child_record) = child.as_object() else {
            return Parsed::Invalid;
        };
        if !matches!(text(child_record, "type"), Some("pane" | "split")) {
            return Parsed::Invalid;
        }
        match parse_node(child, pane_ids, depth + 1, true) {
            Parsed::Retired => {}
            Parsed::Invalid | Parsed::Node(SnapshotNode::Tabs(_)) => return Parsed::Invalid,
            Parsed::Node(SnapshotNode::Pane(pane)) => tabs.push(SnapshotTabItem::Pane(pane)),
            Parsed::Node(SnapshotNode::Split(split)) => {
                tabs.push(SnapshotTabItem::Split(SnapshotSplit {
                    name: normalize_split_tab_name(child_record.get("name")),
                    folded: is_true(child_record, "folded"),
                    ..split
                }));
            }
        }
    }
    if tabs.is_empty() {
        return Parsed::Retired;
    }
    if tabs.len() == 1 {
        return tabs
            .pop()
            .map_or(Parsed::Invalid, |item| Parsed::Node(item.into_node()));
    }
    let mut ids = Vec::new();
    for item in &tabs {
        item.collect_pane_ids(&mut ids);
    }
    let Some(first) = ids.first().cloned() else {
        return Parsed::Invalid;
    };
    let active_id = text(record, "activeId")
        .filter(|active| ids.iter().any(|pane| pane.as_str() == *active))
        .map_or(first, str::to_owned);
    Parsed::Node(SnapshotNode::Tabs(SnapshotTabs {
        id: id.to_owned(),
        children: tabs,
        active_id,
    }))
}

fn parse_split(
    record: &Record,
    id: &str,
    pane_ids: &mut Vec<String>,
    depth: usize,
    in_tab: bool,
) -> Parsed {
    let Some(children_raw) = record
        .get("children")
        .and_then(Value::as_array)
        .filter(|children| !children.is_empty())
    else {
        return Parsed::Invalid;
    };
    let direction = if text(record, "direction") == Some("vertical") {
        SplitDirection::Vertical
    } else {
        SplitDirection::Horizontal
    };
    let mut children = Vec::new();
    let mut kept = Vec::new();
    for (index, child) in children_raw.iter().enumerate() {
        match parse_node(child, pane_ids, depth + 1, in_tab) {
            Parsed::Retired => {}
            Parsed::Invalid => return Parsed::Invalid,
            Parsed::Node(node) => {
                children.push(node);
                kept.push(index);
            }
        }
    }
    if children.is_empty() {
        return Parsed::Retired;
    }
    if children.len() == 1 && (in_tab || kept.len() < children_raw.len()) {
        return children.pop().map_or(Parsed::Invalid, Parsed::Node);
    }
    let sizes = split_sizes(record.get("sizes"), children_raw.len(), &kept);
    Parsed::Node(SnapshotNode::Split(SnapshotSplit {
        id: id.to_owned(),
        direction,
        children,
        sizes,
        name: None,
        folded: false,
    }))
}

fn split_sizes(raw: Option<&Value>, child_count: usize, kept: &[usize]) -> Vec<JsNumber> {
    let given: Option<Vec<f64>> = raw
        .and_then(Value::as_array)
        .filter(|sizes| sizes.len() == child_count)
        .and_then(|sizes| {
            sizes
                .iter()
                .map(|size| size.as_f64().filter(|n| n.is_finite() && *n > 0.0))
                .collect()
        });
    match given {
        Some(sizes) => kept
            .iter()
            .filter_map(|&index| sizes.get(index).copied().map(JsNumber))
            .collect(),
        None => vec![JsNumber(1.0); kept.len()],
    }
}
