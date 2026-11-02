use std::collections::HashSet;

use ostia_base::js::js_trim;
use serde_json::Value;

use super::fields::{id_text, is_true, text};
use super::layout::{Parsed, parse_node};
use super::model::{
    PanePlacement, SnapshotGroup, SnapshotWorkspace, WorkspaceKind, WorkspaceOrigin,
};
use super::{CUSTOM_NAME_MAX, MAX_GROUPS, PROJECT_DIR_MAX};
use crate::PanePlacementZone;
use crate::js_text::utf16_prefix;
use crate::workspace_text::{WorkspaceGroupColor, normalize_description, normalize_group_name};

const ORIGIN_INDEX_MAX: f64 = 1000.0;

#[derive(Default)]
pub struct Claims {
    panes: HashSet<String>,
    workspaces: HashSet<String>,
}

pub fn parse_groups(raw: Option<&Value>) -> Vec<SnapshotGroup> {
    let Some(entries) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut groups: Vec<SnapshotGroup> = Vec::new();
    for entry in entries {
        if groups.len() >= MAX_GROUPS {
            break;
        }
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(id) = text(record, "id").filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(name) = normalize_group_name(record.get("name")) else {
            continue;
        };
        if groups.iter().any(|group| group.id == id) {
            continue;
        }
        groups.push(SnapshotGroup {
            id: id.to_owned(),
            name,
            color: text(record, "color").and_then(WorkspaceGroupColor::parse),
            collapsed: is_true(record, "collapsed"),
        });
    }
    groups
}

pub fn parse_placement(raw: Option<&Value>) -> Option<PanePlacement> {
    let record = raw?.as_object()?;
    let pane_id = id_text(record.get("paneId"))?;
    let zone = PanePlacementZone::parse(text(record, "zone")?)?;
    Some(PanePlacement {
        pane_id: pane_id.to_owned(),
        zone,
    })
}

fn parse_origin(raw: Option<&Value>) -> Option<WorkspaceOrigin> {
    let record = raw?.as_object()?;
    let workspace_id = id_text(record.get("workspaceId"))?;
    let index = match record.get("index").and_then(Value::as_f64) {
        Some(index) if index.fract() == 0.0 => index.clamp(0.0, ORIGIN_INDEX_MAX) as u32,
        _ => 0,
    };
    Some(WorkspaceOrigin {
        workspace_id: workspace_id.to_owned(),
        index,
        group_id: id_text(record.get("groupId")).map(str::to_owned),
        beside: parse_placement(record.get("beside")),
    })
}

pub fn active_of(raw: Option<&Value>, workspaces: &[SnapshotWorkspace]) -> Option<String> {
    match raw
        .and_then(Value::as_str)
        .filter(|id| workspaces.iter().any(|workspace| workspace.id == *id))
    {
        Some(id) => Some(id.to_owned()),
        None => workspaces.first().map(|workspace| workspace.id.clone()),
    }
}

pub fn parse_workspace(
    entry: &Value,
    known_groups: &[SnapshotGroup],
    claims: &mut Claims,
    scratch: bool,
) -> Option<SnapshotWorkspace> {
    let record = entry.as_object()?;
    let id = text(record, "id").filter(|id| !id.is_empty())?;
    if claims.workspaces.contains(id) {
        return None;
    }
    if text(record, "kind") == Some("scratch") && !scratch {
        return None;
    }
    let mut pane_ids = Vec::new();
    let root = match record.get("root") {
        None => None,
        Some(raw_root) => match parse_node(raw_root, &mut pane_ids, 0, false) {
            Parsed::Node(node) => Some(node),
            Parsed::Retired => None,
            Parsed::Invalid => return None,
        },
    };
    if root.is_some() && pane_ids.is_empty() {
        return None;
    }
    if pane_ids.iter().collect::<HashSet<_>>().len() != pane_ids.len() {
        return None;
    }
    if pane_ids.iter().any(|pane| claims.panes.contains(pane)) {
        return None;
    }
    let custom_name = text(record, "customName")
        .map(|name| utf16_prefix(js_trim(name), CUSTOM_NAME_MAX))
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let pinned = is_true(record, "pinned");
    let group_id = if pinned {
        None
    } else {
        text(record, "groupId")
            .filter(|group| known_groups.iter().any(|known| known.id == *group))
            .map(str::to_owned)
    };
    let name = text(record, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_owned();
    let kind = if text(record, "kind") == Some("scratch") {
        WorkspaceKind::Scratch
    } else {
        WorkspaceKind::Terminal
    };
    let work_dir = text(record, "workDir")
        .filter(|dir| !dir.is_empty())
        .unwrap_or("~")
        .to_owned();
    let project_dir = text(record, "projectDir")
        .filter(|dir| !dir.is_empty())
        .map(|dir| utf16_prefix(dir, PROJECT_DIR_MAX).to_owned());
    let description = normalize_description(record.get("description"));
    let origin = parse_origin(record.get("origin"));
    let (root, active_pane_id) = match root {
        Some(node) => {
            let active = text(record, "activePaneId")
                .filter(|active| pane_ids.iter().any(|pane| pane.as_str() == *active))
                .map(str::to_owned)
                .or_else(|| pane_ids.first().cloned());
            (Some(node), active)
        }
        None => (None, None),
    };
    claims.workspaces.insert(id.to_owned());
    claims.panes.extend(pane_ids);
    Some(SnapshotWorkspace {
        id: id.to_owned(),
        name,
        custom_name,
        description,
        pinned,
        group_id,
        kind,
        work_dir,
        project_dir,
        anchored: is_true(record, "anchored"),
        root,
        active_pane_id,
        origin,
    })
}

pub fn parse_workspace_list(
    entries: &[Value],
    known_groups: &[SnapshotGroup],
    claims: &mut Claims,
    scratch: bool,
    limit: usize,
) -> Vec<SnapshotWorkspace> {
    let mut workspaces = Vec::new();
    for entry in entries {
        if workspaces.len() >= limit {
            break;
        }
        if let Some(workspace) = parse_workspace(entry, known_groups, claims, scratch) {
            workspaces.push(workspace);
        }
    }
    workspaces
}
