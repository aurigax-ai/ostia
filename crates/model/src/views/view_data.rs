use std::cmp::Reverse;
use std::collections::HashMap;

use chrono::DateTime;
use ostia_contract::attention::NotificationEntry;
use ostia_contract::extensions::{ExtensionSidebarItem, WorkspaceChip};
use ostia_contract::views::ViewSource;
use serde::Serialize;
use serde_json::{Map, Value, json};
use url::Url;

use crate::attention::{EMPTY_ATTENTION, PaneAttention, unread_count};
use crate::layout::tree::all_panes;
use crate::layout::types::SurfaceKind;
use crate::workspaces::layout_store::WorkspaceLayout;
use crate::workspaces::workspace_title::workspace_title;
use crate::workspaces::workspaces_store::Workspace;

pub const VIEW_NOTIFICATIONS_MAX: usize = 50;

const PORTS_SOURCE: &str = "ports";
const PORTS_CHIP: &str = "ports";
const GIT_SOURCE: &str = "git";

pub struct ViewDataInputs<'a> {
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    pub by_workspace: HashMap<String, WorkspaceLayout>,
    pub attention: HashMap<String, PaneAttention>,
    pub sidebar: Vec<ExtensionSidebarItem>,
    pub workspace_chips: Vec<WorkspaceChip>,
    pub approvals: usize,
    pub notifications: Vec<NotificationEntry>,
    pub agent_of: &'a dyn Fn(&str) -> Option<String>,
    pub now: i64,
}

struct PortData {
    port: u16,
    url: Option<String>,
    workspace: String,
    workspace_id: String,
}

fn text_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn surface_kind_name(kind: SurfaceKind) -> &'static str {
    match kind {
        SurfaceKind::Terminal => "terminal",
        SurfaceKind::Editor => "editor",
        SurfaceKind::Agent => "agent",
        SurfaceKind::Browser => "browser",
        SurfaceKind::Diff => "diff",
        SurfaceKind::Chat => "chat",
        SurfaceKind::Git => "git",
        SurfaceKind::View => "view",
        SurfaceKind::Manager => "manager",
    }
}

fn explicit_port(raw: &str, parsed: &Url) -> Option<u16> {
    parsed.port().or_else(|| {
        let rest = raw.trim().split_once("://")?.1;
        let authority = rest.split(['/', '?', '#']).next()?;
        let host_port = authority.rsplit('@').next()?;
        host_port.rsplit_once(':')?.1.parse().ok()
    })
}

fn port_of(url: Option<&str>) -> Option<u16> {
    let raw = url.filter(|text| !text.is_empty())?;
    let parsed = Url::parse(raw).ok()?;
    explicit_port(raw, &parsed).filter(|port| *port > 0)
}

fn ports_of(inputs: &ViewDataInputs) -> Vec<PortData> {
    let mut out = Vec::new();
    for chip in &inputs.workspace_chips {
        if chip.chip.ext_id != PORTS_SOURCE || chip.chip.id != PORTS_CHIP {
            continue;
        }
        let workspace = inputs
            .workspaces
            .iter()
            .find(|candidate| candidate.id == chip.workspace_id)
            .map_or("", |candidate| candidate.name.as_str());
        for item in chip.chip.items.as_deref().unwrap_or_default() {
            let Some(port) = port_of(item.url.as_deref()) else {
                continue;
            };
            out.push(PortData {
                port,
                url: item.url.clone(),
                workspace: workspace.to_owned(),
                workspace_id: chip.workspace_id.clone(),
            });
        }
    }
    out.sort_by_key(|port| port.port);
    out
}

fn git_of(inputs: &ViewDataInputs, workspace_id: &str) -> Option<String> {
    inputs
        .sidebar
        .iter()
        .find(|item| {
            item.ext_id == GIT_SOURCE
                && item.workspace_id.as_deref() == Some(workspace_id)
                && !item.text.is_empty()
        })
        .map(|item| item.text.clone())
}

fn workspace_data(inputs: &ViewDataInputs, ports: &[PortData]) -> Vec<Value> {
    inputs
        .workspaces
        .iter()
        .enumerate()
        .map(|(index, workspace)| {
            let ids: Vec<String> = inputs
                .by_workspace
                .get(&workspace.id)
                .map(|layout| {
                    all_panes(&layout.root)
                        .iter()
                        .map(|pane| pane.id.clone())
                        .collect()
                })
                .unwrap_or_default();
            let project = workspace
                .project_dir
                .as_deref()
                .filter(|dir| !dir.is_empty())
                .map(|dir| json!({ "name": workspace.name, "path": dir }));
            json!({
                "id": workspace.id,
                "index": index,
                "name": workspace_title(&workspace.name, workspace.custom_name.as_deref()),
                "project": project,
                "dir": workspace.work_dir,
                "description": workspace.description,
                "state": text_of(&workspace.state),
                "unread": unread_count(&inputs.attention, &ids),
                "active": inputs.active_workspace_id.as_deref() == Some(workspace.id.as_str()),
                "pinned": workspace.pinned,
                "panes": ids.len(),
                "git": git_of(inputs, &workspace.id),
                "ports": ports
                    .iter()
                    .filter(|port| port.workspace_id == workspace.id)
                    .map(|port| json!({ "port": port.port, "url": port.url }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect()
}

fn pane_data(inputs: &ViewDataInputs) -> Vec<Value> {
    let Some(layout) = inputs
        .active_workspace_id
        .as_ref()
        .and_then(|id| inputs.by_workspace.get(id))
    else {
        return Vec::new();
    };
    let empty = EMPTY_ATTENTION;
    all_panes(&layout.root)
        .iter()
        .map(|pane| {
            let attention = inputs.attention.get(&pane.id).unwrap_or(&empty);
            let agent = (pane.kind == SurfaceKind::Terminal)
                .then(|| (inputs.agent_of)(&pane.id))
                .flatten();
            json!({
                "id": pane.id,
                "title": pane.title,
                "kind": surface_kind_name(pane.kind),
                "agent": agent,
                "attention": text_of(&attention.state),
                "unread": attention.unread,
                "message": attention.message,
                "active": pane.id == layout.active_pane_id,
            })
        })
        .collect()
}

fn notification_data(inputs: &ViewDataInputs) -> Vec<Value> {
    let mut entries: Vec<(i64, &NotificationEntry)> = inputs
        .notifications
        .iter()
        .map(|entry| {
            let at =
                DateTime::parse_from_rfc3339(&entry.ts).map_or(0, |time| time.timestamp_millis());
            (at, entry)
        })
        .collect();
    entries.sort_by_key(|(at, _)| Reverse(*at));
    entries
        .into_iter()
        .take(VIEW_NOTIFICATIONS_MAX)
        .map(|(at, entry)| {
            json!({
                "id": entry.id,
                "title": entry.title,
                "body": entry.body,
                "kind": text_of(&entry.kind),
                "from": entry.from,
                "at": at,
            })
        })
        .collect()
}

pub fn build_view_scope(inputs: &ViewDataInputs, sources: &[ViewSource]) -> Map<String, Value> {
    let mut scope = Map::new();
    let wants = |source: ViewSource| sources.contains(&source);
    let wants_workspace = wants(ViewSource::Workspace) || wants(ViewSource::Workspaces);
    let ports = if wants(ViewSource::Ports) || wants_workspace {
        ports_of(inputs)
    } else {
        Vec::new()
    };
    if wants_workspace {
        let workspaces = workspace_data(inputs, &ports);
        if wants(ViewSource::Workspace) {
            let active = workspaces
                .iter()
                .find(|workspace| workspace["active"] == Value::Bool(true))
                .cloned()
                .unwrap_or(Value::Null);
            scope.insert("workspace".to_owned(), active);
        }
        if wants(ViewSource::Workspaces) {
            scope.insert("workspaces".to_owned(), Value::Array(workspaces));
        }
    }
    if wants(ViewSource::Panes) {
        scope.insert("panes".to_owned(), Value::Array(pane_data(inputs)));
    }
    if wants(ViewSource::Ports) {
        let list = ports
            .iter()
            .map(|port| {
                json!({
                    "port": port.port,
                    "url": port.url,
                    "workspace": port.workspace,
                    "workspaceId": port.workspace_id,
                })
            })
            .collect();
        scope.insert("ports".to_owned(), Value::Array(list));
    }
    if wants(ViewSource::Approvals) {
        scope.insert(
            "approvals".to_owned(),
            json!({ "pending": inputs.approvals }),
        );
    }
    if wants(ViewSource::Notifications) {
        scope.insert(
            "notifications".to_owned(),
            Value::Array(notification_data(inputs)),
        );
    }
    if wants(ViewSource::Clock) {
        scope.insert("clock".to_owned(), json!({ "now": inputs.now }));
    }
    scope
}
