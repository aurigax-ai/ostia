use std::collections::HashSet;
use std::os::fd::AsFd;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, js_number, js_trim, static_regex};
use regex::Regex;
use tokio::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerVerdict {
    Outside,
    Inside,
    Unknown,
}

pub trait ProcReader: Send + Sync {
    fn read(&self, path: &str) -> Option<String>;
}

pub struct CallerContext {
    pub main_pid: i64,
    pub pane_ttys: HashSet<i64>,
    pub proc: Box<dyn ProcReader>,
}

const MAX_ANCESTRY: usize = 128;
const SS_TIMEOUT: Duration = Duration::from_millis(3000);
const SS_MAX_BUFFER: usize = 16 * 1024 * 1024;
const TOKEN_ENTRIES: [&str; 2] = ["OSTIA_TOKEN=", "OSTIA_TOKEN_FILE="];

#[derive(Debug, PartialEq, Eq)]
pub struct ProcStat {
    pub ppid: i64,
    pub tty_nr: i64,
}

static SPACES: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

static SS_LINE: LazyLock<Regex> = LazyLock::new(|| {
    let space = format!("[{JS_SPACE_CLASS}]");
    let visible = format!("[^{JS_SPACE_CLASS}]");
    static_regex(&format!(
        "^{visible}+{space}+{visible}+{space}+[0-9]+{space}+[0-9]+{space}+({JS_DOT}+?){space}+([0-9]+){space}+({JS_DOT}+?){space}+([0-9]+)(?:{space}+users:\\(({JS_DOT}*)\\))?{space}*$"
    ))
});

static PID: LazyLock<Regex> = LazyLock::new(|| static_regex("pid=([0-9]+)"));

fn integer_of(text: Option<&str>) -> Option<i64> {
    let number = js_number(text?);
    (number.is_finite() && number.fract() == 0.0).then_some(number as i64)
}

pub fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let close = text.rfind(')')?;
    let rest = js_trim(&text[close + 1..]);
    let fields: Vec<&str> = SPACES.split(rest).collect();
    Some(ProcStat {
        ppid: integer_of(fields.get(1).copied())?,
        tty_nr: integer_of(fields.get(4).copied())?,
    })
}

pub fn has_pane_token(environ: &str) -> bool {
    environ
        .split('\0')
        .any(|entry| TOKEN_ENTRIES.iter().any(|prefix| entry.starts_with(prefix)))
}

fn stat_of(pid: i64, proc: &dyn ProcReader) -> Option<ProcStat> {
    parse_proc_stat(&proc.read(&format!("/proc/{pid}/stat"))?)
}

fn descends_from_main(pid: i64, ctx: &CallerContext) -> Option<bool> {
    let mut current = pid;
    let mut hop = 0;
    while hop < MAX_ANCESTRY && current > 1 {
        if current == ctx.main_pid {
            return Some(true);
        }
        let Some(stat) = stat_of(current, ctx.proc.as_ref()) else {
            return if hop == 0 { None } else { Some(false) };
        };
        current = stat.ppid;
        hop += 1;
    }
    Some(false)
}

pub fn judge_caller(pid: i64, ctx: &CallerContext) -> CallerVerdict {
    let stat = stat_of(pid, ctx.proc.as_ref());
    let environ = ctx.proc.read(&format!("/proc/{pid}/environ"));
    let (Some(stat), Some(environ)) = (stat, environ) else {
        return CallerVerdict::Unknown;
    };
    if has_pane_token(&environ) {
        return CallerVerdict::Inside;
    }
    if stat.tty_nr != 0 && ctx.pane_ttys.contains(&stat.tty_nr) {
        return CallerVerdict::Inside;
    }
    match descends_from_main(pid, ctx) {
        None => CallerVerdict::Unknown,
        Some(true) => CallerVerdict::Inside,
        Some(false) => CallerVerdict::Outside,
    }
}

pub fn judge_callers(pids: &[i64], ctx: &CallerContext) -> CallerVerdict {
    if pids.is_empty() {
        return CallerVerdict::Unknown;
    }
    let mut verdict = CallerVerdict::Outside;
    for pid in pids {
        match judge_caller(*pid, ctx) {
            CallerVerdict::Inside => return CallerVerdict::Inside,
            CallerVerdict::Unknown => verdict = CallerVerdict::Unknown,
            CallerVerdict::Outside => {}
        }
    }
    verdict
}

pub fn peer_pids_from_ss(output: &str, server_inode: u64) -> Vec<i64> {
    let mut pids: Vec<i64> = Vec::new();
    for line in output.split('\n') {
        let Some(captures) = SS_LINE.captures(js_trim(line)) else {
            continue;
        };
        if js_number(&captures[4]) != server_inode as f64 {
            continue;
        }
        let Some(users) = captures.get(5).filter(|users| !users.as_str().is_empty()) else {
            continue;
        };
        for pid in PID.captures_iter(users.as_str()) {
            let pid = js_number(&pid[1]) as i64;
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

pub fn ttys_of(pids: impl IntoIterator<Item = i64>, proc: &dyn ProcReader) -> HashSet<i64> {
    pids.into_iter()
        .filter_map(|pid| stat_of(pid, proc))
        .filter(|stat| stat.tty_nr != 0)
        .map(|stat| stat.tty_nr)
        .collect()
}

pub struct ProcFs;

impl ProcReader for ProcFs {
    fn read(&self, path: &str) -> Option<String> {
        let bytes = std::fs::read(path).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn socket_inode(socket: &impl AsFd) -> Option<u64> {
    rustix::fs::fstat(socket).ok().map(|stat| stat.st_ino)
}

pub async fn list_unix_sockets() -> Option<String> {
    let child = Command::new("ss")
        .arg("-xpnH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let output = tokio::time::timeout(SS_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > SS_MAX_BUFFER {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn caller_verdict(
    socket: &impl AsFd,
    ctx: &CallerContext,
    list: impl FnOnce() -> BoxFuture<'static, Option<String>>,
) -> CallerVerdict {
    let Some(inode) = socket_inode(socket) else {
        return CallerVerdict::Unknown;
    };
    let Some(output) = list().await else {
        return CallerVerdict::Unknown;
    };
    judge_callers(&peer_pids_from_ss(&output, inode), ctx)
}
