use std::collections::{HashMap, HashSet};
use std::time::Duration;

use ostia_base::host::Platform;
use ostia_base::procfs::{ProcEntry, children_of, parse_proc_stat, process_tree};
use tokio::process::Command;

use crate::darwin::{parse_lsof_listeners, parse_ps_table, ports_of_tree, split_ps_args};
use crate::procfs::{
    ListeningSocket, SocketHolder, parse_net_tcp, ports_for_holders, process_name, socket_inode,
};
use crate::ssh::{ssh_args, ssh_login};
use crate::{ListeningPort, TreeInfo};

const PROC: &str = "/proc";
const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_MAX_OUTPUT: usize = 8 * 1024 * 1024;

pub async fn scan_trees(roots: &[i32], host_pid: i32) -> HashMap<i32, TreeInfo> {
    if roots.is_empty() {
        return HashMap::new();
    }
    match Platform::current() {
        Platform::Linux => {
            let roots = roots.to_vec();
            tokio::task::spawn_blocking(move || scan_linux(&roots, host_pid))
                .await
                .unwrap_or_default()
        }
        Platform::Darwin => scan_darwin(roots, host_pid).await,
    }
}

async fn tool_output(program: &str, args: &[&str]) -> String {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(TOOL_TIMEOUT, command.output()).await else {
        return String::new();
    };
    let end = output.stdout.len().min(TOOL_MAX_OUTPUT);
    String::from_utf8_lossy(&output.stdout[..end]).into_owned()
}

fn read_text(path: &str) -> String {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn dir_names(path: &str) -> Vec<String> {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn linux_proc_table() -> Vec<ProcEntry> {
    dir_names(PROC)
        .into_iter()
        .filter(|name| is_digits(name))
        .filter_map(|name| parse_proc_stat(&read_text(&format!("{PROC}/{name}/stat"))))
        .collect()
}

fn linux_listening() -> Vec<ListeningSocket> {
    let mut sockets = parse_net_tcp(&read_text(&format!("{PROC}/net/tcp")));
    sockets.extend(parse_net_tcp(&read_text(&format!("{PROC}/net/tcp6"))));
    sockets
}

fn socket_inodes(pid: i32) -> Vec<String> {
    let fd_dir = format!("{PROC}/{pid}/fd");
    dir_names(&fd_dir)
        .iter()
        .filter_map(|fd| std::fs::read_link(format!("{fd_dir}/{fd}")).ok())
        .filter_map(|link| socket_inode(&link.to_string_lossy()))
        .collect()
}

fn foreground_ssh<'a>(tree: &[i32], by_pid: &'a HashMap<i32, ProcEntry>) -> Option<&'a ProcEntry> {
    tree.iter()
        .filter_map(|pid| by_pid.get(pid))
        .find(|entry| entry.comm == "ssh" && entry.tpgid > 0 && entry.pgrp == entry.tpgid)
}

fn linux_ports(
    tree: &[i32],
    sockets: &[ListeningSocket],
    by_pid: &HashMap<i32, ProcEntry>,
) -> Vec<ListeningPort> {
    let listening: HashSet<&str> = sockets.iter().map(|socket| socket.inode.as_str()).collect();
    let held: Vec<Vec<String>> = tree.iter().map(|&pid| socket_inodes(pid)).collect();
    let holders: Vec<SocketHolder> = tree
        .iter()
        .zip(held)
        .map(|(&pid, inodes)| {
            let comm = by_pid.get(&pid).map(|entry| entry.comm.clone());
            if !inodes
                .iter()
                .any(|inode| listening.contains(inode.as_str()))
            {
                return SocketHolder {
                    name: comm,
                    inodes: Vec::new(),
                };
            }
            let exe = std::fs::read_link(format!("{PROC}/{pid}/exe"))
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            SocketHolder {
                name: process_name(&exe, comm.as_deref()),
                inodes,
            }
        })
        .collect();
    ports_for_holders(sockets, &holders)
}

fn scan_linux(roots: &[i32], host_pid: i32) -> HashMap<i32, TreeInfo> {
    let procs = linux_proc_table();
    let inherited: HashSet<String> = socket_inodes(host_pid).into_iter().collect();
    let sockets: Vec<ListeningSocket> = linux_listening()
        .into_iter()
        .filter(|socket| !inherited.contains(&socket.inode))
        .collect();
    let children = children_of(&procs);
    let by_pid: HashMap<i32, ProcEntry> = procs.into_iter().map(|p| (p.pid, p)).collect();
    let mut out = HashMap::new();
    for &root in roots {
        if !by_pid.contains_key(&root) {
            continue;
        }
        let tree = process_tree(root, &children);
        let ports = if sockets.is_empty() {
            Vec::new()
        } else {
            linux_ports(&tree, &sockets, &by_pid)
        };
        let ssh = foreground_ssh(&tree, &by_pid);
        let login = ssh.and_then(|entry| {
            let text = read_text(&format!("{PROC}/{}/cmdline", entry.pid));
            let argv: Vec<&str> = text.split('\0').collect();
            ssh_login(&ssh_args(&argv))
        });
        out.insert(root, TreeInfo { ports, ssh: login });
    }
    out
}

async fn scan_darwin(roots: &[i32], host_pid: i32) -> HashMap<i32, TreeInfo> {
    let (ps, lsof) = tokio::join!(
        tool_output("ps", &["-axo", "pid=,ppid=,pgid=,tpgid=,comm="]),
        tool_output("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]),
    );
    let procs = parse_ps_table(&ps);
    let children = children_of(&procs);
    let by_pid: HashMap<i32, ProcEntry> = procs.into_iter().map(|p| (p.pid, p)).collect();
    let listeners = parse_lsof_listeners(&lsof);
    let inherited: HashSet<u16> = listeners
        .get(&host_pid)
        .into_iter()
        .flatten()
        .copied()
        .collect();
    let mut out = HashMap::new();
    for &root in roots {
        if !by_pid.contains_key(&root) {
            continue;
        }
        let tree = process_tree(root, &children);
        let ports = ports_of_tree(&tree, &listeners, &by_pid, &inherited);
        let login = match foreground_ssh(&tree, &by_pid) {
            Some(entry) => {
                let pid = entry.pid.to_string();
                let args = tool_output("ps", &["-o", "args=", "-p", pid.as_str()]).await;
                ssh_login(&ssh_args(&split_ps_args(&args)))
            }
            None => None,
        };
        out.insert(root, TreeInfo { ports, ssh: login });
    }
    out
}
