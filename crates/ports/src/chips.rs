use std::collections::HashMap;

use ostia_contract::extensions::{ExtensionIcon, PANE_CHIP_ITEMS_MAX, SidebarTone};
use serde::Serialize;

use crate::sidebar::{PaneRef, WorkspaceProcesses, port_url};
use crate::ssh::ssh_label;
use crate::{PortHost, TreeInfo};

const SSH_CHIP: &str = "ssh";
const PORTS_CHIP: &str = "ports";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneChipValue {
    pub pane_id: String,
    pub id: &'static str,
    pub text: String,
    pub tone: SidebarTone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChipItem {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChipValue {
    pub workspace_id: String,
    pub id: &'static str,
    pub icon: ExtensionIcon,
    pub text: String,
    pub items: Vec<ChipItem>,
}

pub fn pane_chip_values(panes: &[PaneRef], trees: &HashMap<i32, TreeInfo>) -> Vec<PaneChipValue> {
    panes
        .iter()
        .filter(|pane| pane.kind == "terminal")
        .filter_map(|pane| {
            let pid = pane.pid.filter(|pid| *pid != 0)?;
            let login = trees.get(&pid)?.ssh.as_ref()?;
            Some(PaneChipValue {
                pane_id: pane.pane_id.clone(),
                id: SSH_CHIP,
                text: ssh_label(login),
                tone: SidebarTone::Brand,
            })
        })
        .collect()
}

pub fn workspace_chip_values(
    groups: &[(String, WorkspaceProcesses)],
    host: PortHost,
) -> Vec<WorkspaceChipValue> {
    groups
        .iter()
        .filter(|(_, group)| !group.ports.is_empty())
        .map(|(workspace_id, group)| WorkspaceChipValue {
            workspace_id: workspace_id.clone(),
            id: PORTS_CHIP,
            icon: ExtensionIcon::Plugs,
            text: group.ports.len().to_string(),
            items: group
                .ports
                .iter()
                .take(PANE_CHIP_ITEMS_MAX)
                .map(|port| ChipItem {
                    text: format!(":{}", port.port),
                    detail: port.name.clone().filter(|name| !name.is_empty()),
                    url: port_url(port.port, host),
                })
                .collect(),
        })
        .collect()
}
