use std::collections::HashSet;

use serde_json::Value;

use super::fields::{Record, text};
use super::model::{DetachedBounds, LeftPanel, SnapshotWindow, WindowBounds};
use super::workspace::{Claims, active_of, parse_workspace_list};
use super::{MAX_WINDOWS, MAX_WORKSPACES};
use crate::js_text::js_round;
use crate::patterns::{is_extension_id, is_window_id};

const BOUNDS_MIN: f64 = 100.0;
const BOUNDS_MAX: f64 = 100_000.0;

pub fn side_panels(record: &Record) -> (Option<LeftPanel>, Option<String>) {
    let left = (text(record, "leftPanel") == Some("files")).then_some(LeftPanel::Files);
    let right = text(record, "rightPanel")
        .filter(|panel| is_extension_id(panel))
        .map(str::to_owned);
    (left, right)
}

pub fn parse_bounds(raw: Option<&Value>) -> Option<WindowBounds> {
    let record = raw?.as_object()?;
    let number = |key: &str| record.get(key).and_then(Value::as_f64);
    let x = number("x")?;
    let y = number("y")?;
    let width = number("width")?;
    let height = number("height")?;
    let coords_ok = [x, y].iter().all(|coord| coord.abs() <= BOUNDS_MAX);
    let sizes_ok = [width, height]
        .iter()
        .all(|size| (BOUNDS_MIN..=BOUNDS_MAX).contains(size));
    (coords_ok && sizes_ok).then(|| WindowBounds {
        x: js_round(x) as i64,
        y: js_round(y) as i64,
        width: js_round(width) as i64,
        height: js_round(height) as i64,
    })
}

pub fn parse_windows(
    raw: Option<&Value>,
    claims: &mut Claims,
    budget: usize,
) -> Vec<SnapshotWindow> {
    let Some(entries) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut windows: Vec<SnapshotWindow> = Vec::new();
    let mut left = budget;
    for entry in entries {
        if windows.len() >= MAX_WINDOWS || left == 0 {
            break;
        }
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(workspace_entries) = record.get("workspaces").and_then(Value::as_array) else {
            continue;
        };
        let bounds = parse_bounds(record.get("bounds"));
        let Some(id) = text(record, "id").filter(|id| is_window_id(id)) else {
            continue;
        };
        let Some(bounds) = bounds else {
            continue;
        };
        if windows.iter().any(|window| window.id == id) {
            continue;
        }
        let workspaces = parse_workspace_list(workspace_entries, &[], claims, false, left);
        if workspaces.is_empty() {
            continue;
        }
        left -= workspaces.len();
        let (left_panel, right_panel) = side_panels(record);
        windows.push(SnapshotWindow {
            id: id.to_owned(),
            bounds,
            active_workspace_id: active_of(record.get("activeWorkspaceId"), &workspaces),
            left_panel,
            right_panel,
            workspaces,
        });
    }
    windows
}

pub fn parse_detached_bounds(
    raw: Option<&Value>,
    known: &HashSet<String>,
) -> Option<DetachedBounds> {
    let record = raw?.as_object()?;
    let mut entries = Vec::new();
    for (id, value) in record {
        if entries.len() >= MAX_WORKSPACES {
            break;
        }
        if !known.contains(id.as_str()) {
            continue;
        }
        if let Some(bounds) = parse_bounds(Some(value)) {
            entries.push((id.clone(), bounds));
        }
    }
    (!entries.is_empty()).then_some(DetachedBounds(entries))
}
