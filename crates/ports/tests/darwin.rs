#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};

use ostia_base::procfs::{ProcEntry, children_of, process_tree};
use ostia_ports::ListeningPort;
use ostia_ports::darwin::{parse_lsof_listeners, parse_ps_table, ports_of_tree, split_ps_args};
use ostia_testkit::fixture_text;

fn fixture(name: &str) -> String {
    fixture_text(&format!("ports/{name}")).unwrap()
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

fn named(port: u16, name: &str) -> ListeningPort {
    ListeningPort {
        port,
        name: Some(name.to_owned()),
    }
}

fn unnamed(port: u16) -> ListeningPort {
    ListeningPort { port, name: None }
}

fn by_pid(procs: &[ProcEntry]) -> HashMap<i32, ProcEntry> {
    procs.iter().map(|p| (p.pid, p.clone())).collect()
}

#[test]
fn reads_pid_ppid_process_group_foreground_group_and_the_command_basename() {
    let procs = parse_ps_table(&fixture("ps-table.txt"));
    assert!(procs.contains(&proc_entry(600, 500, 600, 600, "ssh")));
    assert!(procs.contains(&proc_entry(700, 1, 700, -1, "Electron")));
    assert_eq!(process_tree(500, &children_of(&procs)), vec![500, 501, 600]);
}

#[test]
fn skips_ps_lines_that_do_not_have_five_columns() {
    let text = "  PID  PPID  PGID TPGID COMMAND\n  10 1 10 10 zsh\n10 1 10\n\nabc 1 10 10 zsh\n  11 10 11 -1 /usr/bin/node  \n";
    assert_eq!(
        parse_ps_table(text),
        vec![
            proc_entry(10, 1, 10, 10, "zsh"),
            proc_entry(11, 10, 11, -1, "node"),
        ]
    );
}

#[test]
fn keeps_spaces_inside_a_command_path_and_takes_the_basename_after_the_last_slash() {
    let procs = parse_ps_table(
        "  5 1 5 5 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n  6 1 6 6 plain name\n",
    );
    assert_eq!(
        procs,
        vec![
            proc_entry(5, 1, 5, 5, "Electron"),
            proc_entry(6, 1, 6, 6, "plain name"),
        ]
    );
}

#[test]
fn groups_listening_ports_by_pid_and_skips_unparsable_names() {
    let expected: HashMap<i32, Vec<u16>> = HashMap::from([(501, vec![3000]), (777, vec![5173])]);
    assert_eq!(parse_lsof_listeners(&fixture("lsof-listen.txt")), expected);
}

#[test]
fn skips_lsof_names_with_a_port_outside_one_to_65535_or_no_pid_yet() {
    let text = "n*:3000\np10\nn*:0\nn*:65536\nn*:65535\nn*:1\nn*:abc\nn*:\nnno-colon\nn*:1.5\np0\nn*:4000\npx\nn*:4001\np11\nf3\nn*:4002\n";
    let expected: HashMap<i32, Vec<u16>> = HashMap::from([(10, vec![65535, 1]), (11, vec![4002])]);
    assert_eq!(parse_lsof_listeners(text), expected);
}

#[test]
fn lists_a_port_once_per_pid_in_the_order_first_seen() {
    let text = "p10\nn*:9000\nn[::1]:9000\nn*:8000\np11\nn*:9000\np10\nn*:7000\nn*:8000\n";
    let expected: HashMap<i32, Vec<u16>> =
        HashMap::from([(10, vec![9000, 8000, 7000]), (11, vec![9000])]);
    assert_eq!(parse_lsof_listeners(text), expected);
}

#[test]
fn names_each_port_by_the_basename_of_the_process_listening_on_it() {
    let procs = parse_ps_table(&fixture("ps-table.txt"));
    let table = by_pid(&procs);
    let tree = process_tree(500, &children_of(&procs));
    let listeners: HashMap<i32, Vec<u16>> =
        HashMap::from([(501, vec![5173, 3000]), (600, vec![2222])]);
    assert_eq!(
        ports_of_tree(&tree, &listeners, &table, &HashSet::new()),
        vec![named(2222, "ssh"), named(3000, "node"), named(5173, "node")]
    );
}

#[test]
fn keeps_a_port_whose_process_is_gone_from_the_table_without_a_name() {
    let procs = parse_ps_table(&fixture("ps-table.txt"));
    let table = by_pid(&procs);
    let mut tree = process_tree(500, &children_of(&procs));
    tree.push(999);
    let listeners: HashMap<i32, Vec<u16>> = HashMap::from([(999, vec![8000])]);
    assert_eq!(
        ports_of_tree(&tree, &listeners, &table, &HashSet::new()),
        vec![unnamed(8000)]
    );
}

#[test]
fn leaves_out_ports_the_app_itself_already_held() {
    let procs = parse_ps_table(&fixture("ps-table.txt"));
    let table = by_pid(&procs);
    let tree = process_tree(500, &children_of(&procs));
    let listeners: HashMap<i32, Vec<u16>> = HashMap::from([(501, vec![3000, 5173])]);
    assert_eq!(
        ports_of_tree(&tree, &listeners, &table, &HashSet::from([3000])),
        vec![named(5173, "node")]
    );
}

#[test]
fn names_a_port_after_the_first_process_in_the_tree_that_holds_it() {
    let procs = vec![
        proc_entry(1, 0, 1, 1, "first"),
        proc_entry(2, 1, 1, 1, "second"),
    ];
    let table = by_pid(&procs);
    let listeners: HashMap<i32, Vec<u16>> = HashMap::from([(1, vec![4000]), (2, vec![4000, 4001])]);
    assert_eq!(
        ports_of_tree(&[1, 2], &listeners, &table, &HashSet::new()),
        vec![named(4000, "first"), named(4001, "second")]
    );
}

#[test]
fn ignores_listeners_of_a_pid_that_is_not_in_the_tree() {
    let procs = parse_ps_table(&fixture("ps-table.txt"));
    let table = by_pid(&procs);
    let listeners: HashMap<i32, Vec<u16>> = HashMap::from([(700, vec![9999])]);
    assert_eq!(
        ports_of_tree(&[500, 501], &listeners, &table, &HashSet::new()),
        Vec::<ListeningPort>::new()
    );
}

#[test]
fn splits_a_ps_args_column_on_whitespace() {
    assert_eq!(
        split_ps_args("  ssh -p 22 me@box\n"),
        vec!["ssh", "-p", "22", "me@box"]
    );
}

#[test]
fn gives_no_args_for_blank_text_and_splits_on_every_js_space() {
    assert!(split_ps_args("").is_empty());
    assert!(split_ps_args(" \t\n ").is_empty());
    assert_eq!(
        split_ps_args("a\u{feff}b\u{a0}c\td"),
        vec!["a", "b", "c", "d"]
    );
}
