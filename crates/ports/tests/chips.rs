#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_ports::chips::{pane_chip_values, workspace_chip_values};
use ostia_ports::sidebar::{PaneRef, WorkspaceProcesses};
use ostia_ports::ssh::SshLogin;
use ostia_ports::{ListeningPort, PortHost, TreeInfo};
use serde_json::{Value, json};

fn pane(pane_id: &str, pid: Option<i32>, kind: &str) -> PaneRef {
    PaneRef {
        pane_id: pane_id.to_owned(),
        workspace_id: "s1".to_owned(),
        kind: kind.to_owned(),
        pid,
    }
}

fn terminal(pane_id: &str, pid: Option<i32>) -> PaneRef {
    pane(pane_id, pid, "terminal")
}

fn unnamed(port: u16) -> ListeningPort {
    ListeningPort { port, name: None }
}

fn named(port: u16, name: &str) -> ListeningPort {
    ListeningPort {
        port,
        name: Some(name.to_owned()),
    }
}

fn trees() -> HashMap<i32, TreeInfo> {
    HashMap::from([
        (
            10,
            TreeInfo {
                ports: vec![unnamed(3000), unnamed(5173)],
                ssh: None,
            },
        ),
        (
            11,
            TreeInfo {
                ports: vec![],
                ssh: Some(SshLogin {
                    user: Some("deploy".to_owned()),
                    host: "build-box".to_owned(),
                }),
            },
        ),
        (
            12,
            TreeInfo {
                ports: vec![],
                ssh: None,
            },
        ),
    ])
}

fn groups(entries: Vec<(&str, WorkspaceProcesses)>) -> Vec<(String, WorkspaceProcesses)> {
    entries
        .into_iter()
        .map(|(id, group)| (id.to_owned(), group))
        .collect()
}

fn processes(ports: Vec<ListeningPort>, ssh: &[&str]) -> WorkspaceProcesses {
    WorkspaceProcesses {
        ports,
        ssh: ssh.iter().map(|s| (*s).to_owned()).collect(),
    }
}

fn as_json<T: serde::Serialize>(values: &[T]) -> Value {
    serde_json::to_value(values).unwrap()
}

#[test]
fn gives_a_terminal_running_ssh_a_login_chip_with_user_at_host() {
    let chips = pane_chip_values(&[terminal("b", Some(11))], &trees());
    assert_eq!(
        as_json(&chips),
        json!([{"paneId": "b", "id": "ssh", "text": "deploy@build-box", "tone": "brand"}])
    );
}

#[test]
fn gives_no_pane_chip_for_listening_ports_idle_terminals_panes_without_a_pty_or_other_kinds() {
    let chips = pane_chip_values(
        &[
            terminal("a", Some(10)),
            terminal("c", Some(12)),
            terminal("d", None),
            pane("e", Some(11), "browser"),
        ],
        &trees(),
    );
    assert_eq!(as_json(&chips), json!([]));
}

#[test]
fn gives_a_workspace_with_listeners_one_icon_chip_with_the_port_count_and_a_link_per_port_named_by_its_process()
 {
    let all = groups(vec![
        (
            "s1",
            processes(
                vec![named(3000, "node"), named(5173, "node"), unnamed(8000)],
                &[],
            ),
        ),
        ("s2", processes(vec![], &["box"])),
    ]);
    let chips = workspace_chip_values(&all, PortHost::Localhost);
    assert_eq!(
        as_json(&chips),
        json!([{
            "workspaceId": "s1",
            "id": "ports",
            "icon": "plugs",
            "text": "3",
            "items": [
                {"text": ":3000", "detail": "node", "url": "http://localhost:3000/"},
                {"text": ":5173", "detail": "node", "url": "http://localhost:5173/"},
                {"text": ":8000", "url": "http://localhost:8000/"},
            ],
        }])
    );
}

#[test]
fn lists_at_most_the_chip_item_limit_while_the_count_says_how_many_listen() {
    let ports: Vec<ListeningPort> = (0..70).map(|i| unnamed(30000 + i)).collect();
    let all = groups(vec![("s1", processes(ports, &[]))]);
    let chips = as_json(&workspace_chip_values(&all, PortHost::Localhost));
    assert_eq!(chips[0]["text"], json!("70"));
    assert_eq!(chips[0]["items"].as_array().unwrap().len(), 64);
}

#[test]
fn uses_the_configured_host_in_the_port_link() {
    let all = groups(vec![("s1", processes(vec![unnamed(5173)], &[]))]);
    let chips = as_json(&workspace_chip_values(&all, PortHost::Loopback));
    assert_eq!(chips[0]["items"][0]["url"], json!("http://127.0.0.1:5173/"));
}
