use ostia_contract::attention::WorkspaceLiveState;

use super::workspace_order::{NewWorkspacePlacement, Orderable, insert_index};
use crate::ids::{IdMint, IdNamespace};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WorkspaceKind {
    #[default]
    Terminal,
    Scratch,
    Manager,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub pinned: bool,
    pub kind: WorkspaceKind,
    pub work_dir: String,
    pub state: WorkspaceLiveState,
}

impl Orderable for Workspace {
    fn order_id(&self) -> &str {
        &self.id
    }

    fn is_pinned(&self) -> bool {
        self.pinned
    }
}

pub fn name_from_work_dir(work_dir: &str) -> String {
    if work_dir.is_empty() || work_dir == "~" {
        return "home".to_owned();
    }
    let last = work_dir.trim_end_matches('/').rsplit('/').next();
    last.filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_owned()
}

#[derive(Clone, Debug, Default)]
pub struct WorkspacesStore {
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
    ids: IdMint,
}

impl WorkspacesStore {
    pub fn new(namespace: IdNamespace) -> Self {
        Self {
            ids: IdMint::new(namespace),
            ..Self::default()
        }
    }

    pub fn workspaces(&self) -> &[Workspace] {
        &self.workspaces
    }

    pub fn active_workspace_id(&self) -> Option<&str> {
        self.active_workspace_id.as_deref()
    }

    pub fn active_workspace(&self) -> Option<&Workspace> {
        self.active_workspace_id
            .as_deref()
            .and_then(|id| self.workspace(id))
    }

    pub fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|workspace| workspace.id == id)
    }

    pub fn work_dir_of(&self, id: &str) -> Option<&str> {
        self.workspace(id)
            .map(|workspace| workspace.work_dir.as_str())
    }

    pub fn set_active(&mut self, id: &str) -> bool {
        if self.active_workspace_id.as_deref() == Some(id) {
            return false;
        }
        self.active_workspace_id = Some(id.to_owned());
        true
    }

    pub fn add_workspace(
        &mut self,
        work_dir: &str,
        placement: NewWorkspacePlacement,
        kind: WorkspaceKind,
    ) -> String {
        let id = self.ids.next("w", "");
        let at = insert_index(
            &self.workspaces,
            placement,
            self.active_workspace_id.as_deref(),
        );
        self.workspaces.insert(
            at,
            Workspace {
                id: id.clone(),
                name: name_from_work_dir(work_dir),
                custom_name: None,
                pinned: false,
                kind,
                work_dir: work_dir.to_owned(),
                state: WorkspaceLiveState::Idle,
            },
        );
        self.active_workspace_id = Some(id.clone());
        id
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let Some(at) = self
            .workspaces
            .iter()
            .position(|workspace| workspace.id == id)
        else {
            return false;
        };
        self.workspaces.remove(at);
        if self.active_workspace_id.as_deref() == Some(id) {
            self.active_workspace_id = self
                .workspaces
                .get(at.saturating_sub(1))
                .or_else(|| self.workspaces.first())
                .map(|workspace| workspace.id.clone());
        }
        true
    }

    pub fn set_work_dir(&mut self, id: &str, work_dir: &str) -> bool {
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id)
        else {
            return false;
        };
        workspace.work_dir = work_dir.to_owned();
        workspace.name = name_from_work_dir(work_dir);
        true
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id)
        else {
            return false;
        };
        let custom_name = name.trim();
        workspace.custom_name = (!custom_name.is_empty()).then(|| custom_name.to_owned());
        true
    }

    pub fn set_state(&mut self, id: &str, state: WorkspaceLiveState) -> bool {
        let Some(workspace) = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id && workspace.state != state)
        else {
            return false;
        };
        workspace.state = state;
        true
    }
}
