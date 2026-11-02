use std::collections::{HashMap, HashSet};

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProcEntry {
    pub pid: i32,
    pub ppid: i32,
    pub pgrp: i32,
    pub tpgid: i32,
    pub comm: String,
}

pub fn parse_proc_stat(text: &str) -> Option<ProcEntry> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close < open {
        return None;
    }
    let pid: i32 = text[..open].trim().parse().ok()?;
    if pid <= 0 {
        return None;
    }
    let comm = text[open + 1..close].to_owned();
    let rest_str = text[close + 1..].trim();
    if rest_str.is_empty() {
        return None;
    }
    let mut rest = rest_str.split_ascii_whitespace();
    let _state = rest.next()?;
    let ppid: i32 = rest.next()?.parse().ok()?;
    let pgrp: i32 = rest.next()?.parse().ok()?;
    let _session = rest.next()?;
    let _tty_nr = rest.next()?;
    let tpgid: i32 = rest.next()?.parse().ok()?;
    Some(ProcEntry {
        pid,
        ppid,
        pgrp,
        tpgid,
        comm,
    })
}

pub fn children_of(procs: &[ProcEntry]) -> HashMap<i32, Vec<i32>> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    children
}

pub fn process_tree(root: i32, children: &HashMap<i32, Vec<i32>>) -> Vec<i32> {
    let mut seen = HashSet::new();
    seen.insert(root);
    let mut queue = vec![root];
    let mut i = 0;
    while i < queue.len() {
        let current = queue[i];
        if let Some(kids) = children.get(&current) {
            for &child in kids {
                if seen.insert(child) {
                    queue.push(child);
                }
            }
        }
        i += 1;
    }
    queue
}
