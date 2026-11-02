use std::collections::{BTreeSet, HashMap};

use ostia_contract::extensions::ExtensionIcon;

pub use ostia_contract::extensions::SidebarKind;

use crate::procfs::{Owners, add_owner, sorted_ports};
use crate::{ListeningPort, PortHost, TreeInfo};

const SSH_KEY: &str = "ssh";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneRef {
    pub pane_id: String,
    pub workspace_id: String,
    pub kind: String,
    pub pid: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceProcesses {
    pub ports: Vec<ListeningPort>,
    pub ssh: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarEntry {
    pub workspace_id: String,
    pub key: String,
    pub text: String,
    pub icon: Option<ExtensionIcon>,
    pub badge: Option<String>,
    pub kind: SidebarKind,
}

pub fn terminal_pids(panes: &[PaneRef]) -> Vec<i32> {
    panes
        .iter()
        .filter(|pane| pane.kind == "terminal")
        .filter_map(|pane| pane.pid.filter(|pid| *pid != 0))
        .collect()
}

pub fn group_by_workspace(
    panes: &[PaneRef],
    trees: &HashMap<i32, TreeInfo>,
) -> Vec<(String, WorkspaceProcesses)> {
    let mut groups: Vec<(String, Owners, BTreeSet<String>)> = Vec::new();
    for pane in panes {
        let Some(tree) = pane
            .pid
            .filter(|pid| *pid != 0)
            .and_then(|pid| trees.get(&pid))
        else {
            continue;
        };
        let index = match groups
            .iter()
            .position(|(workspace_id, _, _)| *workspace_id == pane.workspace_id)
        {
            Some(index) => index,
            None => {
                groups.push((pane.workspace_id.clone(), Owners::new(), BTreeSet::new()));
                groups.len() - 1
            }
        };
        let Some((_, ports, hosts)) = groups.get_mut(index) else {
            continue;
        };
        for port in &tree.ports {
            add_owner(ports, port.port, port.name.as_deref());
        }
        if let Some(login) = &tree.ssh {
            hosts.insert(login.host.clone());
        }
    }
    groups
        .into_iter()
        .map(|(workspace_id, ports, hosts)| {
            (
                workspace_id,
                WorkspaceProcesses {
                    ports: sorted_ports(&ports),
                    ssh: hosts.into_iter().collect(),
                },
            )
        })
        .collect()
}

pub fn port_url(port: u16, host: PortHost) -> String {
    let host = match host {
        PortHost::Localhost => "localhost",
        PortHost::Loopback => "127.0.0.1",
    };
    format!("http://{host}:{port}/")
}

pub fn sidebar_entries(groups: &[(String, WorkspaceProcesses)]) -> Vec<SidebarEntry> {
    groups
        .iter()
        .filter(|(_, group)| !group.ssh.is_empty())
        .map(|(workspace_id, group)| SidebarEntry {
            workspace_id: workspace_id.clone(),
            key: SSH_KEY.to_owned(),
            text: group.ssh.join(" "),
            icon: None,
            badge: Some("SSH".to_owned()),
            kind: SidebarKind::Live,
        })
        .collect()
}
