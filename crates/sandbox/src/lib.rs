pub mod package_env;
pub mod package_lookups;
pub mod package_policy;
pub mod package_requests;
pub mod packages;
pub mod visibility;

use std::collections::HashSet;
use std::sync::Arc;

use ostia_base::WorkspaceId;
use parking_lot::Mutex;

#[derive(Clone, Default)]
pub struct WorkspaceSandboxes {
    enabled: Arc<Mutex<HashSet<WorkspaceId>>>,
}

impl WorkspaceSandboxes {
    pub fn enable(&self, workspace_id: WorkspaceId) {
        self.enabled.lock().insert(workspace_id);
    }

    pub fn is_enabled(&self, workspace_id: &WorkspaceId) -> bool {
        self.enabled.lock().contains(workspace_id)
    }
}
