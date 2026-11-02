#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::sidebar::group_peers::{
    AgentGroupPlacement, GroupMember, GroupPeersInput, WorkspaceKind, group_mates, group_peer_ids,
};

fn member(id: &str, kind: WorkspaceKind, group_id: Option<&str>) -> GroupMember {
    GroupMember {
        id: id.to_owned(),
        kind,
        group_id: group_id.map(str::to_owned),
    }
}

fn terminal(id: &str, group_id: Option<&str>) -> GroupMember {
    member(id, WorkspaceKind::Terminal, group_id)
}

fn placement(workspace_id: &str, group_id: &str) -> AgentGroupPlacement {
    AgentGroupPlacement {
        workspace_id: workspace_id.to_owned(),
        group_id: group_id.to_owned(),
    }
}

fn unsandboxed(ids: &[&str]) -> HashMap<String, bool> {
    ids.iter().map(|id| ((*id).to_owned(), false)).collect()
}

fn input(
    workspaces: Vec<GroupMember>,
    workspace_id: &str,
    sandboxed: HashMap<String, bool>,
    agent_placements: Option<Vec<AgentGroupPlacement>>,
) -> GroupPeersInput {
    GroupPeersInput {
        workspaces,
        workspace_id: workspace_id.to_owned(),
        sandboxed,
        agent_placements,
    }
}

fn ids(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn group_mates_lists_every_workspace_in_the_same_group_including_itself() {
    let workspaces = vec![
        terminal("a", Some("g1")),
        terminal("b", Some("g2")),
        terminal("c", Some("g1")),
    ];
    let mates = group_mates(&workspaces, "a");
    assert_eq!(
        mates.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "c"]
    );
}

#[test]
fn group_mates_is_empty_for_an_unknown_ungrouped_or_empty_group_workspace() {
    let workspaces = vec![
        terminal("a", None),
        terminal("b", None),
        terminal("c", Some("")),
        terminal("d", Some("")),
    ];
    assert!(group_mates(&workspaces, "missing").is_empty());
    assert!(group_mates(&workspaces, "a").is_empty());
    assert!(group_mates(&workspaces, "c").is_empty());
}

#[test]
fn group_peer_ids_is_empty_when_the_agent_placements_are_unknown() {
    let workspaces = vec![terminal("a", Some("g")), terminal("b", Some("g"))];
    let peers = group_peer_ids(&input(workspaces, "a", unsandboxed(&["a", "b"]), None));
    assert!(peers.is_empty());
}

#[test]
fn group_peer_ids_returns_the_other_unsandboxed_group_mates_in_order() {
    let workspaces = vec![
        terminal("a", Some("g")),
        terminal("b", Some("g")),
        terminal("c", Some("g")),
        terminal("d", Some("other")),
    ];
    let peers = group_peer_ids(&input(
        workspaces,
        "b",
        unsandboxed(&["a", "b", "c", "d"]),
        Some(vec![]),
    ));
    assert_eq!(peers, ids(&["a", "c"]));
}

#[test]
fn group_peer_ids_skips_scratch_and_manager_workspaces() {
    let workspaces = vec![
        terminal("a", Some("g")),
        member("s", WorkspaceKind::Scratch, Some("g")),
        member("m", WorkspaceKind::Manager, Some("g")),
        terminal("b", Some("g")),
    ];
    let peers = group_peer_ids(&input(
        workspaces,
        "a",
        unsandboxed(&["a", "s", "m", "b"]),
        Some(vec![]),
    ));
    assert_eq!(peers, ids(&["b"]));
}

#[test]
fn group_peer_ids_is_empty_when_the_source_is_scratch_or_manager() {
    for kind in [WorkspaceKind::Scratch, WorkspaceKind::Manager] {
        let workspaces = vec![member("a", kind, Some("g")), terminal("b", Some("g"))];
        let peers = group_peer_ids(&input(
            workspaces,
            "a",
            unsandboxed(&["a", "b"]),
            Some(vec![]),
        ));
        assert!(peers.is_empty(), "{kind:?}");
    }
}

#[test]
fn group_peer_ids_needs_an_explicit_false_sandbox_flag() {
    let workspaces = vec![
        terminal("a", Some("g")),
        terminal("b", Some("g")),
        terminal("c", Some("g")),
        terminal("d", Some("g")),
    ];
    let mut sandboxed = unsandboxed(&["a", "d"]);
    sandboxed.insert("b".to_owned(), true);
    let peers = group_peer_ids(&input(workspaces, "a", sandboxed, Some(vec![])));
    assert_eq!(peers, ids(&["d"]));
}

#[test]
fn group_peer_ids_is_empty_when_the_source_is_sandboxed_or_has_no_flag() {
    let workspaces = vec![terminal("a", Some("g")), terminal("b", Some("g"))];
    let mut sandboxed = unsandboxed(&["b"]);
    let missing = group_peer_ids(&input(
        workspaces.clone(),
        "a",
        sandboxed.clone(),
        Some(vec![]),
    ));
    assert!(missing.is_empty());
    sandboxed.insert("a".to_owned(), true);
    let flagged = group_peer_ids(&input(workspaces, "a", sandboxed, Some(vec![])));
    assert!(flagged.is_empty());
}

#[test]
fn group_peer_ids_skips_a_workspace_an_agent_already_placed_in_its_group() {
    let workspaces = vec![
        terminal("a", Some("g")),
        terminal("b", Some("g")),
        terminal("c", Some("g")),
    ];
    let peers = group_peer_ids(&input(
        workspaces,
        "a",
        unsandboxed(&["a", "b", "c"]),
        Some(vec![placement("b", "g"), placement("c", "elsewhere")]),
    ));
    assert_eq!(peers, ids(&["c"]));
}

#[test]
fn group_peer_ids_is_empty_when_the_source_has_an_agent_placement_in_its_group() {
    let workspaces = vec![terminal("a", Some("g")), terminal("b", Some("g"))];
    let peers = group_peer_ids(&input(
        workspaces,
        "a",
        unsandboxed(&["a", "b"]),
        Some(vec![placement("a", "g")]),
    ));
    assert!(peers.is_empty());
}

#[test]
fn group_peer_ids_is_empty_for_an_ungrouped_or_unknown_workspace() {
    let workspaces = vec![terminal("a", None), terminal("b", None)];
    let sandboxed = unsandboxed(&["a", "b"]);
    assert!(
        group_peer_ids(&input(
            workspaces.clone(),
            "a",
            sandboxed.clone(),
            Some(vec![])
        ))
        .is_empty()
    );
    assert!(group_peer_ids(&input(workspaces, "missing", sandboxed, Some(vec![]))).is_empty());
}
