use ostia_contract::windows_api::{WindowSummary, WindowWorkspaceSummary};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteWorkspace {
    pub workspace: WindowWorkspaceSummary,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceSlot {
    pub id: String,
    pub window_id: Option<String>,
}

pub fn remote_workspaces_of(
    list: &[WindowSummary],
    window_id: Option<&str>,
) -> Vec<RemoteWorkspace> {
    list.iter()
        .filter(|window| Some(window.window_id.as_str()) != window_id)
        .flat_map(|window| {
            window.workspaces.iter().map(|workspace| RemoteWorkspace {
                workspace: workspace.clone(),
                window_id: window.window_id.clone(),
            })
        })
        .collect()
}

pub fn global_workspace_order(
    list: &[WindowSummary],
    window_id: Option<&str>,
    local: &[String],
) -> Vec<WorkspaceSlot> {
    let own = || {
        local.iter().map(|id| WorkspaceSlot {
            id: id.clone(),
            window_id: window_id.map(str::to_owned),
        })
    };
    if !list
        .iter()
        .any(|window| Some(window.window_id.as_str()) == window_id)
    {
        return own()
            .chain(
                remote_workspaces_of(list, window_id)
                    .into_iter()
                    .map(|remote| WorkspaceSlot {
                        id: remote.workspace.id,
                        window_id: Some(remote.window_id),
                    }),
            )
            .collect();
    }
    list.iter()
        .flat_map(|window| {
            if Some(window.window_id.as_str()) == window_id {
                own().collect::<Vec<_>>()
            } else {
                window
                    .workspaces
                    .iter()
                    .map(|workspace| WorkspaceSlot {
                        id: workspace.id.clone(),
                        window_id: Some(window.window_id.clone()),
                    })
                    .collect()
            }
        })
        .collect()
}

pub fn latest_remote_unread(
    list: &[WindowSummary],
    window_id: Option<&str>,
    after: i64,
) -> Option<RemoteWorkspace> {
    let mut best: Option<RemoteWorkspace> = None;
    for remote in remote_workspaces_of(list, window_id) {
        if remote.workspace.unread_at > after
            && best
                .as_ref()
                .is_none_or(|current| remote.workspace.unread_at > current.workspace.unread_at)
        {
            best = Some(remote);
        }
    }
    best
}
