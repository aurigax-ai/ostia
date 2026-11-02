use std::collections::HashMap;

pub use ostia_contract::reach::AgentGroupPlacement;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceKind {
    Terminal,
    Scratch,
    Manager,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupMember {
    pub id: String,
    pub kind: WorkspaceKind,
    pub group_id: Option<String>,
}

pub struct GroupPeersInput {
    pub workspaces: Vec<GroupMember>,
    pub workspace_id: String,
    pub sandboxed: HashMap<String, bool>,
    pub agent_placements: Option<Vec<AgentGroupPlacement>>,
}

pub fn group_mates<'a>(workspaces: &'a [GroupMember], workspace_id: &str) -> Vec<&'a GroupMember> {
    let group_id = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .and_then(|w| w.group_id.as_deref())
        .filter(|group_id| !group_id.is_empty());
    match group_id {
        Some(group_id) => workspaces
            .iter()
            .filter(|w| w.group_id.as_deref() == Some(group_id))
            .collect(),
        None => Vec::new(),
    }
}

pub fn group_peer_ids(input: &GroupPeersInput) -> Vec<String> {
    let Some(placements) = input.agent_placements.as_deref() else {
        return Vec::new();
    };
    let mates = group_mates(&input.workspaces, &input.workspace_id);
    let Some(source) = mates.iter().find(|w| w.id == input.workspace_id) else {
        return Vec::new();
    };
    if !shares(input, placements, source) {
        return Vec::new();
    }
    mates
        .iter()
        .filter(|w| w.id != source.id && shares(input, placements, w))
        .map(|w| w.id.clone())
        .collect()
}

fn shares(
    input: &GroupPeersInput,
    placements: &[AgentGroupPlacement],
    member: &GroupMember,
) -> bool {
    member.kind != WorkspaceKind::Scratch
        && member.kind != WorkspaceKind::Manager
        && input.sandboxed.get(&member.id) == Some(&false)
        && !placements.iter().any(|placement| {
            placement.workspace_id == member.id
                && member.group_id.as_deref() == Some(placement.group_id.as_str())
        })
}
