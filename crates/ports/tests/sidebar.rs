#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_ports::sidebar::{
    PaneRef, SidebarEntry, SidebarKind, WorkspaceProcesses, group_by_workspace, port_url,
    sidebar_entries, terminal_pids,
};
use ostia_ports::ssh::SshLogin;
use ostia_ports::{ListeningPort, PortHost, TreeInfo};

fn pane(pane_id: &str, workspace_id: &str, pid: Option<i32>, kind: &str) -> PaneRef {
    PaneRef {
        pane_id: pane_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        kind: kind.to_owned(),
        pid,
    }
}

fn terminal(pane_id: &str, workspace_id: &str, pid: Option<i32>) -> PaneRef {
    pane(pane_id, workspace_id, pid, "terminal")
}

fn named(port: u16, name: &str) -> ListeningPort {
    ListeningPort {
        port,
        name: Some(name.to_owned()),
    }
}

fn unnamed(port: u16) -> ListeningPort {
    ListeningPort { port, name: None }
}

fn tree(ports: Vec<ListeningPort>, ssh: Option<SshLogin>) -> TreeInfo {
    TreeInfo { ports, ssh }
}

fn login(user: Option<&str>, host: &str) -> SshLogin {
    SshLogin {
        user: user.map(str::to_owned),
        host: host.to_owned(),
    }
}

fn find<'a>(
    groups: &'a [(String, WorkspaceProcesses)],
    workspace_id: &str,
) -> Option<&'a WorkspaceProcesses> {
    groups
        .iter()
        .find(|(id, _)| id == workspace_id)
        .map(|(_, group)| group)
}

fn processes(ports: Vec<ListeningPort>, ssh: &[&str]) -> WorkspaceProcesses {
    WorkspaceProcesses {
        ports,
        ssh: ssh.iter().map(|host| (*host).to_owned()).collect(),
    }
}

#[test]
fn takes_the_pid_of_every_terminal_pane_that_has_a_live_pty() {
    assert_eq!(
        terminal_pids(&[
            terminal("a", "s1", Some(10)),
            terminal("b", "s1", None),
            pane("c", "s1", Some(30), "browser"),
        ]),
        vec![10]
    );
}

#[test]
fn skips_a_terminal_pane_whose_pid_is_zero() {
    assert_eq!(
        terminal_pids(&[terminal("a", "s1", Some(0)), terminal("b", "s1", Some(7))]),
        vec![7]
    );
}

#[test]
fn merges_the_ports_and_ssh_hosts_of_every_terminal_in_a_workspace() {
    let trees: HashMap<i32, TreeInfo> = HashMap::from([
        (10, tree(vec![unnamed(3000), named(5173, "vite")], None)),
        (
            11,
            tree(
                vec![named(3000, "node"), named(8080, "python3")],
                Some(login(Some("deploy"), "prod-1")),
            ),
        ),
        (20, tree(vec![], None)),
    ]);
    let groups = group_by_workspace(
        &[
            terminal("a", "s1", Some(10)),
            terminal("b", "s1", Some(11)),
            terminal("c", "s2", Some(20)),
        ],
        &trees,
    );
    assert_eq!(
        find(&groups, "s1"),
        Some(&processes(
            vec![
                named(3000, "node"),
                named(5173, "vite"),
                named(8080, "python3")
            ],
            &["prod-1"],
        ))
    );
    assert_eq!(find(&groups, "s2"), Some(&processes(vec![], &[])));
}

#[test]
fn leaves_out_a_workspace_whose_panes_have_no_pid_or_no_tree() {
    let trees: HashMap<i32, TreeInfo> = HashMap::from([(10, tree(vec![unnamed(3000)], None))]);
    let groups = group_by_workspace(
        &[
            terminal("a", "s1", None),
            terminal("b", "s2", Some(99)),
            terminal("c", "s3", Some(10)),
        ],
        &trees,
    );
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0, "s3");
}

#[test]
fn lists_each_ssh_host_once_in_sorted_order() {
    let trees: HashMap<i32, TreeInfo> = HashMap::from([
        (1, tree(vec![], Some(login(None, "zeta")))),
        (2, tree(vec![], Some(login(Some("a"), "alpha")))),
        (3, tree(vec![], Some(login(Some("b"), "zeta")))),
    ]);
    let groups = group_by_workspace(
        &[
            terminal("a", "s1", Some(1)),
            terminal("b", "s1", Some(2)),
            terminal("c", "s1", Some(3)),
        ],
        &trees,
    );
    assert_eq!(find(&groups, "s1").unwrap().ssh, vec!["alpha", "zeta"]);
}

#[test]
fn keeps_the_first_name_a_port_got_in_a_workspace_and_fills_a_missing_one() {
    let trees: HashMap<i32, TreeInfo> = HashMap::from([
        (1, tree(vec![unnamed(4000), named(4001, "first")], None)),
        (
            2,
            tree(vec![named(4000, "late"), named(4001, "second")], None),
        ),
    ]);
    let groups = group_by_workspace(
        &[terminal("a", "s1", Some(1)), terminal("b", "s1", Some(2))],
        &trees,
    );
    assert_eq!(
        find(&groups, "s1").unwrap().ports,
        vec![named(4000, "late"), named(4001, "first")]
    );
}

#[test]
fn builds_a_port_url_with_localhost_by_default() {
    assert_eq!(
        port_url(3000, PortHost::default()),
        "http://localhost:3000/"
    );
}

#[test]
fn builds_a_port_url_with_the_chosen_host() {
    assert_eq!(port_url(5173, PortHost::Loopback), "http://127.0.0.1:5173/");
    assert_eq!(port_url(80, PortHost::Localhost), "http://localhost:80/");
}

#[test]
fn makes_one_ssh_item_per_workspace_and_nothing_for_its_ports() {
    let groups = vec![(
        "s1".to_owned(),
        processes(vec![unnamed(3000)], &["box", "prod"]),
    )];
    assert_eq!(
        sidebar_entries(&groups),
        vec![SidebarEntry {
            workspace_id: "s1".to_owned(),
            key: "ssh".to_owned(),
            text: "box prod".to_owned(),
            icon: None,
            badge: Some("SSH".to_owned()),
            kind: SidebarKind::Live,
        }]
    );
}

#[test]
fn shows_nothing_for_a_workspace_with_no_ports_and_no_ssh() {
    let groups = vec![("s1".to_owned(), processes(vec![], &[]))];
    assert!(sidebar_entries(&groups).is_empty());
}

#[test]
fn skips_a_workspace_without_ssh_and_keeps_the_others() {
    let groups = vec![
        ("s1".to_owned(), processes(vec![unnamed(3000)], &[])),
        ("s2".to_owned(), processes(vec![], &["box"])),
        ("s3".to_owned(), processes(vec![], &["prod"])),
    ];
    let entries = sidebar_entries(&groups);
    let ids: Vec<&str> = entries.iter().map(|e| e.workspace_id.as_str()).collect();
    assert_eq!(ids, vec!["s2", "s3"]);
}

#[test]
fn keeps_the_order_the_workspaces_were_given_in_and_does_not_sort_them() {
    let groups = vec![
        ("s9".to_owned(), processes(vec![], &["nine"])),
        ("s1".to_owned(), processes(vec![], &["one"])),
        ("s5".to_owned(), processes(vec![], &["five"])),
    ];
    let entries = sidebar_entries(&groups);
    let ids: Vec<&str> = entries.iter().map(|e| e.workspace_id.as_str()).collect();
    assert_eq!(ids, vec!["s9", "s1", "s5"]);
}

#[test]
fn groups_workspaces_in_the_order_their_panes_first_appear() {
    let trees: HashMap<i32, TreeInfo> = HashMap::from([
        (1, tree(vec![], None)),
        (2, tree(vec![], None)),
        (3, tree(vec![], None)),
    ]);
    let groups = group_by_workspace(
        &[
            terminal("a", "s9", Some(1)),
            terminal("b", "s1", Some(2)),
            terminal("c", "s9", Some(3)),
        ],
        &trees,
    );
    let ids: Vec<&str> = groups.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, vec!["s9", "s1"]);
}
