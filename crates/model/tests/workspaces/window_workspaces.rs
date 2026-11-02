#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::attention::WorkspaceLiveState;
use ostia_contract::windows_api::{WindowSummary, WindowWorkspaceSummary};
use ostia_model::workspaces::window_workspaces::{
    WorkspaceSlot, global_workspace_order, latest_remote_unread, remote_workspaces_of,
};

fn summary(id: &str, unread_at: i64) -> WindowWorkspaceSummary {
    WindowWorkspaceSummary {
        id: id.to_string(),
        name: id.to_string(),
        work_dir: format!("/{id}"),
        state: WorkspaceLiveState::Idle,
        unread_at,
        panes: vec![],
    }
}

fn window(id: &str, detached: bool, workspaces: Vec<WindowWorkspaceSummary>) -> WindowSummary {
    WindowSummary {
        window_id: id.to_string(),
        detached,
        workspaces,
    }
}

fn list() -> Vec<WindowSummary> {
    vec![
        window("1", false, vec![summary("a", 0), summary("b", 0)]),
        window("2", true, vec![summary("c", 30)]),
        window("3", true, vec![summary("d", 20)]),
    ]
}

fn local(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

fn slot(id: &str, window_id: &str) -> WorkspaceSlot {
    WorkspaceSlot {
        id: id.to_string(),
        window_id: Some(window_id.to_string()),
    }
}

#[test]
fn lists_only_the_workspaces_other_windows_hold() {
    let pairs: Vec<(String, String)> = remote_workspaces_of(&list(), Some("2"))
        .into_iter()
        .map(|w| (w.workspace.id, w.window_id))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "1".to_string()),
            ("d".to_string(), "3".to_string()),
        ]
    );
}

#[test]
fn orders_the_main_window_first_then_detached_windows_using_the_live_local_order() {
    let ids: Vec<String> = global_workspace_order(&list(), Some("1"), &local(&["b", "a"]))
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec!["b", "a", "c", "d"]);
}

#[test]
fn keeps_the_same_order_seen_from_a_detached_window() {
    assert_eq!(
        global_workspace_order(&list(), Some("2"), &local(&["c"])),
        vec![
            slot("a", "1"),
            slot("b", "1"),
            slot("c", "2"),
            slot("d", "3")
        ]
    );
}

#[test]
fn falls_back_to_the_local_workspaces_before_the_first_list_arrives() {
    assert_eq!(
        global_workspace_order(&[], Some("1"), &local(&["a"])),
        vec![slot("a", "1")]
    );
}

#[test]
fn picks_the_newest_unread_in_another_window_only_when_it_beats_the_local_one() {
    let list = list();
    assert_eq!(
        latest_remote_unread(&list, Some("1"), 10).map(|w| w.workspace.id),
        Some("c".to_string())
    );
    assert_eq!(latest_remote_unread(&list, Some("1"), 40), None);
    assert_eq!(
        latest_remote_unread(&list, Some("2"), 0).map(|w| w.workspace.id),
        Some("d".to_string())
    );
}

#[test]
fn appends_the_other_windows_after_the_local_ones_when_this_window_is_not_listed() {
    let list = list();
    assert_eq!(
        global_workspace_order(&list, Some("9"), &local(&["z"])),
        vec![
            slot("z", "9"),
            slot("a", "1"),
            slot("b", "1"),
            slot("c", "2"),
            slot("d", "3"),
        ]
    );
}

#[test]
fn keeps_the_first_of_two_workspaces_with_the_same_unread_time() {
    let list = vec![
        window("1", false, vec![]),
        window("2", true, vec![summary("c", 30)]),
        window("3", true, vec![summary("d", 30)]),
    ];
    assert_eq!(
        latest_remote_unread(&list, Some("1"), 0).map(|w| w.workspace.id),
        Some("c".to_string())
    );
}
