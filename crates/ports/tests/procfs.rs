#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::procfs::{ProcEntry, children_of, parse_proc_stat, process_tree};
use ostia_ports::ListeningPort;
use ostia_ports::procfs::{
    ListeningSocket, SocketHolder, parse_net_tcp, ports_for_holders, process_name, socket_inode,
};
use ostia_testkit::fixture_text;

fn fixture(name: &str) -> String {
    fixture_text(&format!("ports/{name}")).unwrap()
}

fn socket(port: u16, inode: &str, uid: u32) -> ListeningSocket {
    ListeningSocket {
        port,
        inode: inode.to_owned(),
        uid,
    }
}

fn proc_entry(pid: i32, ppid: i32, pgrp: i32, tpgid: i32, comm: &str) -> ProcEntry {
    ProcEntry {
        pid,
        ppid,
        pgrp,
        tpgid,
        comm: comm.to_owned(),
    }
}

fn holder(name: Option<&str>, inodes: &[&str]) -> SocketHolder {
    SocketHolder {
        name: name.map(str::to_owned),
        inodes: inodes.iter().map(|inode| (*inode).to_owned()).collect(),
    }
}

fn named(port: u16, name: &str) -> ListeningPort {
    ListeningPort {
        port,
        name: Some(name.to_owned()),
    }
}

#[test]
fn reads_pid_ppid_process_group_and_terminal_foreground_group() {
    assert_eq!(
        parse_proc_stat(&fixture("stat-cat.txt")),
        Some(proc_entry(950_382, 950_242, 950_242, -1, "cat"))
    );
}

#[test]
fn keeps_a_command_name_that_contains_spaces_and_parentheses() {
    assert_eq!(
        parse_proc_stat(&fixture("stat-parens.txt")),
        Some(proc_entry(4242, 1, 4242, 5001, "tmux: server (1)"))
    );
}

#[test]
fn returns_null_for_text_that_is_not_a_stat_line() {
    assert_eq!(parse_proc_stat(""), None);
    assert_eq!(parse_proc_stat("garbage"), None);
    assert_eq!(parse_proc_stat("x (sh) S a b c"), None);
}

#[test]
fn keeps_only_listening_sockets_with_their_port_and_inode() {
    assert_eq!(
        parse_net_tcp(&fixture("net-tcp.txt")),
        vec![
            socket(42771, "3638476", 1000),
            socket(3000, "3598505", 1000),
            socket(53, "9424", 974),
        ]
    );
}

#[test]
fn reads_ipv6_and_v4_mapped_addresses() {
    assert_eq!(
        parse_net_tcp(&fixture("net-tcp6.txt")),
        vec![socket(5173, "60431", 1000), socket(3000, "3598505", 1000)]
    );
}

#[test]
fn returns_nothing_for_an_empty_table() {
    assert_eq!(parse_net_tcp(""), Vec::<ListeningSocket>::new());
}

#[test]
fn extracts_the_inode_of_a_socket_fd_link_and_ignores_other_files() {
    assert_eq!(socket_inode("socket:[3598505]"), Some("3598505".to_owned()));
    assert_eq!(socket_inode("/dev/pts/3"), None);
    assert_eq!(socket_inode("pipe:[123]"), None);
}

fn tree_procs() -> Vec<ProcEntry> {
    vec![
        proc_entry(10, 1, 10, 10, "zsh"),
        proc_entry(11, 10, 11, 11, "pnpm"),
        proc_entry(12, 11, 11, 11, "node"),
        proc_entry(13, 12, 11, 11, "esbuild"),
        proc_entry(20, 1, 20, 20, "bash"),
        proc_entry(21, 20, 21, 21, "python3"),
    ]
}

#[test]
fn walks_every_descendant_of_the_root_root_first() {
    assert_eq!(
        process_tree(10, &children_of(&tree_procs())),
        vec![10, 11, 12, 13]
    );
}

#[test]
fn does_not_cross_into_another_panes_tree() {
    assert_eq!(process_tree(20, &children_of(&tree_procs())), vec![20, 21]);
}

#[test]
fn stops_on_a_cycle_instead_of_looping() {
    let cyclic = vec![proc_entry(5, 6, 5, 5, "a"), proc_entry(6, 5, 5, 5, "b")];
    assert_eq!(process_tree(5, &children_of(&cyclic)), vec![5, 6]);
}

fn fixture_sockets() -> Vec<ListeningSocket> {
    let mut sockets = parse_net_tcp(&fixture("net-tcp.txt"));
    sockets.extend(parse_net_tcp(&fixture("net-tcp6.txt")));
    sockets
}

#[test]
fn names_each_listening_port_by_the_process_holding_its_socket_sorted_and_deduplicated() {
    let sockets = fixture_sockets();
    assert_eq!(
        ports_for_holders(
            &sockets,
            &[
                holder(Some("zsh"), &[]),
                holder(Some("node"), &["3598505", "60431", "999"]),
            ]
        ),
        vec![named(3000, "node"), named(5173, "node")]
    );
    assert_eq!(
        ports_for_holders(&sockets, &[]),
        Vec::<ListeningPort>::new()
    );
}

#[test]
fn keeps_a_port_whose_holder_has_no_readable_name_without_a_name() {
    let sockets = fixture_sockets();
    assert_eq!(
        ports_for_holders(&sockets, &[holder(None, &["3598505"])]),
        vec![ListeningPort {
            port: 3000,
            name: None
        }]
    );
}

#[test]
fn names_a_socket_shared_by_a_parent_and_its_child_after_the_first_holder_in_the_tree() {
    let sockets = fixture_sockets();
    assert_eq!(
        ports_for_holders(
            &sockets,
            &[
                holder(Some("gunicorn"), &["3598505"]),
                holder(Some("worker"), &["3598505"]),
            ]
        ),
        vec![named(3000, "gunicorn")]
    );
}

#[test]
fn names_a_process_by_its_executable_so_a_node_server_is_node_not_its_thread_name() {
    assert_eq!(
        process_name("/usr/bin/node", Some("node-MainThread")),
        Some("node".to_owned())
    );
    assert_eq!(
        process_name("/usr/lib/python3.12/bin/python3.12", Some("python3")),
        Some("python3.12".to_owned())
    );
}

#[test]
fn strips_the_suffix_of_a_deleted_binary() {
    assert_eq!(
        process_name("/usr/bin/node (deleted)", Some("node-MainThread")),
        Some("node".to_owned())
    );
}

#[test]
fn falls_back_to_comm_when_the_link_cannot_be_read_and_to_nothing_without_either() {
    assert_eq!(
        process_name("", Some("postgres")),
        Some("postgres".to_owned())
    );
    assert_eq!(process_name("", None), None);
}
