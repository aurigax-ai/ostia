use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::bounded_run::run_bounded;
use crate::host::Platform;
use crate::js::js_number;
use crate::procfs::parse_proc_stat;

const TOOL_TIMEOUT: Duration = Duration::from_millis(3000);
const DELETED_SUFFIX: &[u8] = b" (deleted)";

fn folder_of(path: &[u8]) -> Option<PathBuf> {
    if path.first() != Some(&b'/') {
        return None;
    }
    let folder = path.strip_suffix(DELETED_SUFFIX).unwrap_or(path);
    Some(PathBuf::from(OsStr::from_bytes(folder)))
}

pub fn linux_foreground_cwd(shell_pid: i32, proc_root: &Path) -> Option<PathBuf> {
    let text = std::fs::read(proc_root.join(shell_pid.to_string()).join("stat")).ok()?;
    let stat = parse_proc_stat(&String::from_utf8_lossy(&text))?;
    if stat.tpgid <= 0 {
        return None;
    }
    let link = std::fs::read_link(proc_root.join(stat.tpgid.to_string()).join("cwd")).ok()?;
    folder_of(&link.into_os_string().into_vec())
}

pub fn darwin_foreground_cwd<F>(shell_pid: i32, run: F) -> Option<PathBuf>
where
    F: Fn(&str, &[String]) -> String,
{
    let ps = run(
        "/bin/ps",
        &[
            "-o".to_owned(),
            "tpgid=".to_owned(),
            "-p".to_owned(),
            shell_pid.to_string(),
        ],
    );
    let tpgid = js_number(&ps);
    if !tpgid.is_finite() || tpgid.fract() != 0.0 || tpgid <= 0.0 {
        return None;
    }
    let out = run(
        "/usr/sbin/lsof",
        &[
            "-a".to_owned(),
            "-p".to_owned(),
            tpgid.to_string(),
            "-d".to_owned(),
            "cwd".to_owned(),
            "-Fn".to_owned(),
        ],
    );
    let line = out.split('\n').find(|line| line.starts_with('n'))?;
    folder_of(&line.as_bytes()[1..])
}

fn tool_output(bin: &str, args: &[String], env: &BTreeMap<String, String>) -> String {
    run_bounded(Path::new(bin), args, env, TOOL_TIMEOUT).unwrap_or_default()
}

pub async fn foreground_cwd(shell_pid: i32, env: BTreeMap<String, String>) -> Option<PathBuf> {
    tokio::task::spawn_blocking(move || match Platform::current() {
        Platform::Linux => linux_foreground_cwd(shell_pid, Path::new("/proc")),
        Platform::Darwin => {
            darwin_foreground_cwd(shell_pid, |bin, args| tool_output(bin, args, &env))
        }
    })
    .await
    .ok()
    .flatten()
}
