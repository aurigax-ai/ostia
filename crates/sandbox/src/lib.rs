pub mod attach_workspace;
pub mod browser_fence;
pub mod domain_requests;
pub mod hook_links;
pub mod host_panes;
pub mod left_behind;
pub mod package_env;
pub mod package_lookups;
pub mod package_policy;
pub mod package_requests;
pub mod packages;
pub mod plugins_farm;
pub mod protocol;
pub mod pty_wrap;
pub mod sandboxed_caller;
pub mod visibility;
pub mod spawn_env;
pub mod srt_config;
pub mod store;
pub mod violations;

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
