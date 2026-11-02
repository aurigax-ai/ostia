use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, js_number, static_regex};
use ostia_base::procfs::ProcEntry;
use regex::Regex;

use crate::ListeningPort;
use crate::procfs::{Owners, add_owner, sorted_ports, split_fields};

static PS_LINE: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^[{JS_SPACE_CLASS}]*([0-9]+)[{JS_SPACE_CLASS}]+([0-9]+)[{JS_SPACE_CLASS}]+([0-9]+)[{JS_SPACE_CLASS}]+(-?[0-9]+)[{JS_SPACE_CLASS}]+({JS_DOT}+?)[{JS_SPACE_CLASS}]*$"
    ))
});

pub fn parse_ps_table(text: &str) -> Vec<ProcEntry> {
    text.split('\n').filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<ProcEntry> {
    let captures = PS_LINE.captures(line)?;
    let number = |index: usize| captures.get(index)?.as_str().parse::<i32>().ok();
    let command = captures.get(5)?.as_str();
    let comm = &command[command.rfind('/').map_or(0, |index| index + 1)..];
    Some(ProcEntry {
        pid: number(1)?,
        ppid: number(2)?,
        pgrp: number(3)?,
        tpgid: number(4)?,
        comm: comm.to_owned(),
    })
}

pub fn parse_lsof_listeners(text: &str) -> HashMap<i32, Vec<u16>> {
    let mut out: HashMap<i32, Vec<u16>> = HashMap::new();
    let mut pid: Option<i32> = None;
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix('p') {
            pid = lsof_pid(rest);
            continue;
        }
        let Some(pid) = pid.filter(|_| line.starts_with('n')) else {
            continue;
        };
        let Some(port) = lsof_port(line) else {
            continue;
        };
        let list = out.entry(pid).or_default();
        if !list.contains(&port) {
            list.push(port);
        }
    }
    out
}

fn whole_number(text: &str) -> Option<f64> {
    let value = js_number(text);
    (value.fract() == 0.0).then_some(value)
}

fn lsof_pid(text: &str) -> Option<i32> {
    let value = whole_number(text)?;
    (1.0..=f64::from(i32::MAX))
        .contains(&value)
        .then_some(value as i32)
}

fn lsof_port(line: &str) -> Option<u16> {
    let start = line.rfind(':').map_or(0, |index| index + 1);
    let value = whole_number(line.get(start..)?)?;
    (1.0..=65535.0).contains(&value).then_some(value as u16)
}

pub fn split_ps_args(text: &str) -> Vec<&str> {
    split_fields(text)
}

pub fn ports_of_tree(
    tree: &[i32],
    listeners: &HashMap<i32, Vec<u16>>,
    by_pid: &HashMap<i32, ProcEntry>,
    inherited: &HashSet<u16>,
) -> Vec<ListeningPort> {
    let mut owners = Owners::new();
    for pid in tree {
        for &port in listeners.get(pid).into_iter().flatten() {
            if !inherited.contains(&port) {
                add_owner(
                    &mut owners,
                    port,
                    by_pid.get(pid).map(|entry| entry.comm.as_str()),
                );
            }
        }
    }
    sorted_ports(&owners)
}
