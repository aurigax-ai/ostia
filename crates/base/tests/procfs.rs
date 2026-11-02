#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::procfs::{ProcEntry, children_of, parse_proc_stat, process_tree};

const TAIL: &str = "4194304 3000 0 0 0 1 0 0 0 20 0 1 0 0";

fn entry(pid: i32, ppid: i32) -> ProcEntry {
    ProcEntry {
        pid,
        ppid,
        pgrp: pid,
        tpgid: 0,
        comm: "x".to_owned(),
    }
}

#[test]
fn reads_ppid_from_field_4_pgrp_from_field_5_and_tpgid_from_field_8() {
    assert_eq!(
        parse_proc_stat(&format!("123 (bash) S 100 200 300 34817 400 {TAIL}")),
        Some(ProcEntry {
            pid: 123,
            comm: "bash".to_owned(),
            ppid: 100,
            pgrp: 200,
            tpgid: 400,
        })
    );
}

#[test]
fn ends_the_command_name_at_the_last_closing_parenthesis() {
    assert_eq!(
        parse_proc_stat(&format!("789 ((my proc) x)) S 100 789 50 0 -1 {TAIL}")),
        Some(ProcEntry {
            pid: 789,
            comm: "(my proc) x)".to_owned(),
            ppid: 100,
            pgrp: 789,
            tpgid: -1,
        })
    );
    assert_eq!(
        parse_proc_stat(&format!("790 (a) S 1 2 3 4 5) R 100 790 50 0 6 {TAIL}"))
            .unwrap()
            .ppid,
        100
    );
}

#[test]
fn does_not_look_at_the_terminal_number() {
    assert_eq!(parse_proc_stat("42 (sh) S 7 42 42 abc 5").unwrap().tpgid, 5);
}

#[test]
fn returns_null_without_a_command_name_in_parentheses() {
    assert_eq!(parse_proc_stat(""), None);
    assert_eq!(parse_proc_stat("123"), None);
    assert_eq!(parse_proc_stat("sh) S 7 42 42 0 5"), None);
    assert_eq!(parse_proc_stat("123 ()"), None);
}

#[test]
fn returns_null_when_the_pid_is_not_a_positive_integer() {
    assert_eq!(
        parse_proc_stat(&format!("abc (bash) S 100 123 50 0 123 {TAIL}")),
        None
    );
    assert_eq!(
        parse_proc_stat(&format!("-1 (bash) S 100 123 50 0 123 {TAIL}")),
        None
    );
    assert_eq!(
        parse_proc_stat(&format!("(bash) S 100 123 50 0 123 {TAIL}")),
        None
    );
}

#[test]
fn returns_null_when_ppid_pgrp_or_tpgid_is_missing_or_not_an_integer() {
    assert_eq!(
        parse_proc_stat(&format!("123 (bash) S abc 123 50 0 123 {TAIL}")),
        None
    );
    assert_eq!(parse_proc_stat("123 (bash) S 100 x 50 0 123"), None);
    assert_eq!(parse_proc_stat("123 (bash) S 100 123 50 0"), None);
}

#[test]
fn groups_the_pids_of_a_table_under_their_parent_in_table_order() {
    let children = children_of(&[entry(5, 1), entry(3, 1), entry(9, 5), entry(1, 0)]);
    assert_eq!(children.get(&1), Some(&vec![5, 3]));
    assert_eq!(children.get(&5), Some(&vec![9]));
    assert_eq!(children.get(&0), Some(&vec![1]));
    assert_eq!(children.get(&9), None);
    assert!(children_of(&[]).is_empty());
}

#[test]
fn lists_a_process_tree_root_first_and_level_by_level() {
    let children = children_of(&[
        entry(2, 1),
        entry(3, 1),
        entry(4, 2),
        entry(5, 3),
        entry(6, 4),
        entry(7, 99),
    ]);
    assert_eq!(process_tree(1, &children), vec![1, 2, 3, 4, 5, 6]);
    assert_eq!(process_tree(4, &children), vec![4, 6]);
    assert_eq!(process_tree(50, &children), vec![50]);
}

#[test]
fn lists_a_process_once_when_the_table_loops() {
    let children = children_of(&[entry(1, 2), entry(2, 1), entry(3, 2)]);
    assert_eq!(process_tree(1, &children), vec![1, 2, 3]);
}
