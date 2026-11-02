use std::sync::Arc;

use crate::open_waits::OpenWaits;

pub type WorkspaceStep = Arc<dyn Fn(&str) + Send + Sync>;

pub struct WorkspaceClosedDeps {
    pub open_waits: OpenWaits,
    pub remove_workspace: WorkspaceStep,
    pub forget_reach: WorkspaceStep,
    pub close_processes: WorkspaceStep,
    pub forget_names: WorkspaceStep,
    pub clear_chips: WorkspaceStep,
    pub close_remote_folders: WorkspaceStep,
    pub tell_extensions: WorkspaceStep,
    pub close_artifacts: WorkspaceStep,
    pub remove_scratch: WorkspaceStep,
    pub forget_requests: WorkspaceStep,
    pub forget_sandbox: WorkspaceStep,
}

pub fn create_workspace_closed(deps: WorkspaceClosedDeps) -> WorkspaceStep {
    Arc::new(move |workspace_id| {
        (deps.remove_workspace)(workspace_id);
        (deps.forget_reach)(workspace_id);
        (deps.close_processes)(workspace_id);
        (deps.forget_names)(workspace_id);
        (deps.clear_chips)(workspace_id);
        (deps.close_remote_folders)(workspace_id);
        (deps.tell_extensions)(workspace_id);
        deps.open_waits.workspace_closed(workspace_id);
        (deps.close_artifacts)(workspace_id);
        (deps.remove_scratch)(workspace_id);
        (deps.forget_requests)(workspace_id);
        (deps.forget_sandbox)(workspace_id);
    })
}
