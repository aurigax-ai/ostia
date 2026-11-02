use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, is_js_space, js_trim, static_regex};
use regex::Regex;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peer {
    pub pid: i32,
    pub start_time: String,
    pub seccomp: u64,
}

pub type ProcReader<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn proc_fs(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

static SECCOMP_LINE: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"(?m)^Seccomp:[{JS_SPACE_CLASS}]*([0-9]+)[{JS_SPACE_CLASS}]*$"
    ))
});

pub fn parse_seccomp(status: &str) -> Option<u64> {
    SECCOMP_LINE.captures(status)?[1].parse().ok()
}

pub fn parse_start_time(stat: &str) -> Option<String> {
    let close = stat.rfind(')')?;
    let field = js_trim(&stat[close + 1..])
        .split(is_js_space)
        .filter(|part| !part.is_empty())
        .nth(19)?;
    (!field.is_empty() && field.bytes().all(|byte| byte.is_ascii_digit())).then(|| field.to_owned())
}

fn start_time_of(pid: i32, proc: ProcReader<'_>) -> Option<String> {
    parse_start_time(&proc(&format!("/proc/{pid}/stat"))?)
}

fn seccomp_of(pid: i32, proc: ProcReader<'_>) -> Option<u64> {
    parse_seccomp(&proc(&format!("/proc/{pid}/status"))?)
}

pub fn read_peer(pid: i32, proc: ProcReader<'_>) -> Option<Peer> {
    let before = start_time_of(pid, proc);
    let seccomp = seccomp_of(pid, proc);
    let after = start_time_of(pid, proc);
    let (before, seccomp, after) = (before?, seccomp?, after?);
    (before == after).then_some(Peer {
        pid,
        start_time: before,
        seccomp,
    })
}

pub fn sandboxed_by_kernel(
    peer: Option<&Peer>,
    shell_pid: Option<i32>,
    proc: ProcReader<'_>,
) -> bool {
    let Some(peer) = peer else {
        return false;
    };
    if peer.seccomp == 0 {
        return false;
    }
    let Some(shell_pid) = shell_pid else {
        return true;
    };
    if start_time_of(peer.pid, proc).is_some_and(|now| now != peer.start_time) {
        return true;
    }
    seccomp_of(shell_pid, proc) == Some(0)
}

fn never_from_sandbox(method: &str) -> bool {
    matches!(
        method,
        "process.run" | "process.kill" | "process.restart" | "agent.run" | "pane.setResume"
    )
}

fn own_pane_key(method: &str) -> Option<&'static str> {
    match method {
        "pane.input" => Some("pane"),
        "pane.close" | "pane.wake" | "pane.moveTo" => Some("panes"),
        _ => None,
    }
}

pub fn escapes_sandbox(method: &str, params: &Value, own: &str) -> bool {
    if never_from_sandbox(method) {
        return true;
    }
    let Some(key) = own_pane_key(method) else {
        return false;
    };
    match params.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Array(refs)) => {
            refs.is_empty() || refs.iter().any(|item| item.as_str() != Some(own))
        }
        Some(given) => given.as_str() != Some(own),
    }
}

pub fn escapes_sandbox_command(id: &str, target_pane_id: Option<&str>, own: &str) -> bool {
    never_from_sandbox(id) || (own_pane_key(id).is_some() && target_pane_id != Some(own))
}
