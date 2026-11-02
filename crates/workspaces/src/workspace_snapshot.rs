mod fields;
mod layout;
pub mod model;
mod pane;
mod window_list;
mod workspace;

use std::collections::HashSet;
use std::path::PathBuf;

use ostia_base::Result;
use ostia_base::host::Host;
use ostia_base::json_store::{SaveOptions, StoreScope, load_json, save_json, store_path};
use serde_json::Value;

use self::model::{AppSnapshot, PaneDrop, SnapshotGroup, SnapshotWorkspace};

const SNAPSHOT_VERSION: u8 = 1;
const MAX_WORKSPACES: usize = 32;
pub(crate) const MAX_PANES: usize = 64;
const MAX_LAYOUT_DEPTH: usize = 12;
const MAX_WINDOWS: usize = 16;
const MAX_GROUPS: usize = 32;
const CUSTOM_NAME_MAX: usize = 120;
const PROJECT_DIR_MAX: usize = 4096;

pub fn parse_snapshot(raw: &Value) -> Option<AppSnapshot> {
    let record = raw.as_object()?;
    if record.get("v").and_then(Value::as_f64) != Some(f64::from(SNAPSHOT_VERSION)) {
        return None;
    }
    let workspace_entries = record.get("workspaces")?.as_array()?;
    let known_groups = workspace::parse_groups(record.get("groups"));
    let mut claims = workspace::Claims::default();
    let workspaces = workspace::parse_workspace_list(
        workspace_entries,
        &known_groups,
        &mut claims,
        false,
        MAX_WORKSPACES,
    );
    let windows = window_list::parse_windows(
        record.get("windows"),
        &mut claims,
        MAX_WORKSPACES - workspaces.len(),
    );
    let known: HashSet<String> = workspaces
        .iter()
        .chain(windows.iter().flat_map(|window| &window.workspaces))
        .map(|workspace| workspace.id.clone())
        .collect();
    let detached_bounds = window_list::parse_detached_bounds(record.get("detachedBounds"), &known);
    let bounds = window_list::parse_bounds(record.get("bounds"));
    let (left_panel, right_panel) = window_list::side_panels(record);
    let groups: Vec<SnapshotGroup> = known_groups
        .into_iter()
        .filter(|group| {
            workspaces
                .iter()
                .any(|workspace| workspace.group_id.as_deref() == Some(group.id.as_str()))
        })
        .collect();
    Some(AppSnapshot {
        v: SNAPSHOT_VERSION,
        saved_at: fields::text(record, "savedAt").unwrap_or("").to_owned(),
        active_workspace_id: workspace::active_of(record.get("activeWorkspaceId"), &workspaces),
        workspaces,
        groups,
        left_panel,
        right_panel,
        bounds,
        detached_bounds,
        windows,
    })
}

pub fn parse_handoff(raw: &Value) -> Option<SnapshotWorkspace> {
    workspace::parse_workspace(raw, &[], &mut workspace::Claims::default(), true)
}

pub fn handoff_pane_ids(workspace: &SnapshotWorkspace) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(root) = &workspace.root {
        root.collect_pane_ids(&mut ids);
    }
    ids
}

pub fn parse_pane_drop(raw: &Value) -> Option<PaneDrop> {
    let record = raw.as_object()?;
    let pane_id = fields::id_text(record.get("paneId"))?;
    let workspace_id = fields::id_text(record.get("workspaceId"))?;
    let placement = workspace::parse_placement(record.get("placement"))?;
    Some(PaneDrop {
        pane_id: pane_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        placement,
    })
}

pub fn snapshot_path(host: &Host) -> PathBuf {
    store_path(host, "workspaces", StoreScope::Global, None)
}

pub fn save_snapshot(host: &Host, snapshot: &AppSnapshot) -> Result<()> {
    save_json(&snapshot_path(host), snapshot, SaveOptions::default())
}

pub fn load_snapshot(host: &Host) -> Option<AppSnapshot> {
    parse_snapshot(&load_json(&snapshot_path(host))?)
}
