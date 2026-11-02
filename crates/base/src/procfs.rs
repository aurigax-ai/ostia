use std::collections::{HashMap, HashSet};

use crate::js::{is_js_space, js_trim};

#[derive(Clone, Debug, PartialEq, Eq)]
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
    let pid = js_trim(&text[..open]).parse::<i32>().ok()?;
    let comm = &text[open + 1..close];
    let fields: Vec<&str> = js_trim(&text[close + 1..])
        .split(is_js_space)
        .filter(|field| !field.is_empty())
        .collect();
    let field = |index: usize| fields.get(index)?.parse::<i32>().ok();
    let ppid = field(1)?;
    let pgrp = field(2)?;
    let tpgid = field(5)?;
    if pid <= 0 {
        return None;
    }
    Some(ProcEntry {
        pid,
        ppid,
        pgrp,
        tpgid,
        comm: comm.to_owned(),
    })
}

pub fn children_of(procs: &[ProcEntry]) -> HashMap<i32, Vec<i32>> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for entry in procs {
        children.entry(entry.ppid).or_default().push(entry.pid);
    }
    children
}

pub fn process_tree(root: i32, children: &HashMap<i32, Vec<i32>>) -> Vec<i32> {
    let mut seen = HashSet::from([root]);
    let mut queue = vec![root];
    let mut next = 0;
    while let Some(&current) = queue.get(next) {
        next += 1;
        for &child in children.get(&current).into_iter().flatten() {
            if seen.insert(child) {
                queue.push(child);
            }
        }
    }
    queue
}
