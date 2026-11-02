#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::TcpListener;

use ostia_ports::scan::scan_trees;

fn own_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap()
}

#[tokio::test]
async fn gives_an_empty_map_for_no_roots() {
    assert!(scan_trees(&[], own_pid()).await.is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn leaves_out_a_root_that_is_not_in_the_process_table() {
    let trees = scan_trees(&[i32::MAX], own_pid()).await;
    assert!(trees.is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn gives_a_listening_port_to_the_tree_that_holds_its_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let trees = scan_trees(&[own_pid()], 1).await;
    let info = trees.get(&own_pid()).unwrap();
    assert!(info.ports.iter().any(|p| p.port == port));
    assert!(info.ports.iter().all(|p| p.name.is_some()));
    assert!(info.ssh.is_none());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ignores_sockets_that_the_host_process_also_holds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let trees = scan_trees(&[own_pid()], own_pid()).await;
    let info = trees.get(&own_pid()).unwrap();
    assert!(info.ports.iter().all(|p| p.port != port));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn gives_a_tree_with_no_listeners_and_no_ssh_an_empty_entry() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    let trees = scan_trees(&[pid], own_pid()).await;
    child.kill().unwrap();
    child.wait().unwrap();
    let info = trees.get(&pid).unwrap();
    assert!(info.ports.is_empty());
    assert!(info.ssh.is_none());
}
