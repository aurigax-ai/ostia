use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use ostia_base::js::non_empty;
use ostia_base::path_guard::expand_home;
use ostia_base::{Host, PaneId, WorkspaceId};

pub struct CwdWorkspace {
    pub workspace_id: WorkspaceId,
    pub work_dir: String,
    pub active_pane_id: Option<PaneId>,
}

pub struct CwdPane {
    pub pane_id: PaneId,
    pub workspace_id: WorkspaceId,
    pub kind: String,
    pub cwd: Option<String>,
}

#[derive(Default)]
pub struct WorkspaceCwds {
    last_terminal: BTreeMap<WorkspaceId, String>,
}

impl WorkspaceCwds {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn resolve(
        &mut self,
        host: &Host,
        workspaces: &[CwdWorkspace],
        panes: &[CwdPane],
    ) -> BTreeMap<WorkspaceId, PathBuf> {
        let live: BTreeSet<&WorkspaceId> = workspaces.iter().map(|w| &w.workspace_id).collect();
        self.last_terminal.retain(|id, _| live.contains(id));
        let mut out = BTreeMap::new();
        for workspace in workspaces {
            let own: Vec<&CwdPane> = panes
                .iter()
                .filter(|p| p.workspace_id == workspace.workspace_id)
                .collect();
            let active = own
                .iter()
                .copied()
                .find(|p| Some(&p.pane_id) == workspace.active_pane_id.as_ref());
            if let Some(cwd) = active
                .filter(|pane| pane.kind == "terminal")
                .and_then(|pane| non_empty(pane.cwd.as_deref()))
            {
                self.last_terminal
                    .insert(workspace.workspace_id.clone(), cwd.to_owned());
            }
            let cwd = non_empty(active.and_then(|pane| pane.cwd.as_deref()))
                .or_else(|| {
                    self.last_terminal
                        .get(&workspace.workspace_id)
                        .map(String::as_str)
                })
                .or_else(|| {
                    own.iter()
                        .copied()
                        .filter(|pane| pane.kind == "terminal")
                        .find_map(|pane| non_empty(pane.cwd.as_deref()))
                })
                .or_else(|| non_empty(Some(workspace.work_dir.as_str())));
            if let Some(cwd) = cwd {
                out.insert(workspace.workspace_id.clone(), expand_home(cwd, &host.home));
            }
        }
        out
    }
}
