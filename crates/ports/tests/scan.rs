#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::TcpListener;

use std::time::Duration;

use ostia_ports::scan::{read_tool, scan_trees};

fn path_env() -> std::collections::BTreeMap<String, String> {
    std::collections::BTreeMap::from([("PATH".to_owned(), std::env::var("PATH").unwrap())])
}

fn own_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap()
}

#[tokio::test]
async fn gives_an_empty_map_for_no_roots() {
    assert!(scan_trees(&[], own_pid(), &path_env()).await.is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn leaves_out_a_root_that_is_not_in_the_process_table() {
    let trees = scan_trees(&[i32::MAX], own_pid(), &path_env()).await;
    assert!(trees.is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn gives_a_listening_port_to_the_tree_that_holds_its_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let trees = scan_trees(&[own_pid()], 1, &path_env()).await;
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
    let trees = scan_trees(&[own_pid()], own_pid(), &path_env()).await;
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
    let trees = scan_trees(&[pid], own_pid(), &path_env()).await;
    child.kill().unwrap();
    child.wait().unwrap();
    let info = trees.get(&pid).unwrap();
    assert!(info.ports.is_empty());
    assert!(info.ssh.is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_the_partial_output_of_a_tool_that_runs_past_the_timeout() {
    let text = read_tool(
        "sh",
        &["-c", "printf partial; exec sleep 30"],
        &path_env(),
        Duration::from_millis(500),
        1024,
    )
    .await;
    assert_eq!(text, "partial");
}

#[cfg(unix)]
#[tokio::test]
async fn stops_reading_a_tool_at_the_output_limit_and_keeps_what_fits() {
    let text = read_tool(
        "sh",
        &["-c", "yes abcdefghij | head -c 100000"],
        &path_env(),
        Duration::from_secs(10),
        1000,
    )
    .await;
    assert_eq!(text.len(), 1000);
}

#[cfg(unix)]
#[tokio::test]
async fn gives_a_tool_only_the_environment_it_is_passed() {
    let env = std::collections::BTreeMap::from([
        ("OSTIA_NO_NEW_PRIVS_RELAUNCHED".to_owned(), "1".to_owned()),
        ("KEPT".to_owned(), "yes".to_owned()),
    ]);
    let text = read_tool("/usr/bin/env", &[], &env, Duration::from_secs(5), 4096).await;
    let mut seen: Vec<&str> = text.lines().collect();
    seen.sort_unstable();
    assert_eq!(seen, ["KEPT=yes", "OSTIA_NO_NEW_PRIVS_RELAUNCHED=1"]);
}
