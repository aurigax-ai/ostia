use std::ffi::OsStr;
use std::io::Read;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::host::Platform;
use crate::js::js_number;
use crate::procfs::parse_proc_stat;

const TOOL_TIMEOUT: Duration = Duration::from_millis(3000);
const TOOL_MAX_OUTPUT: usize = 64 * 1024;
const TOOL_POLL: Duration = Duration::from_millis(10);
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

fn tool_output(bin: &str, args: &[String]) -> String {
    let Ok(mut child) = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let Some(stdout) = child.stdout.take() else {
        return String::new();
    };
    let reader = std::thread::spawn(move || {
        let mut collected = Vec::new();
        let _ = stdout
            .take(u64::try_from(TOOL_MAX_OUTPUT + 1).unwrap_or(u64::MAX))
            .read_to_end(&mut collected);
        collected
    });
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(TOOL_POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let collected = reader.join().unwrap_or_default();
    if success && collected.len() <= TOOL_MAX_OUTPUT {
        String::from_utf8_lossy(&collected).into_owned()
    } else {
        String::new()
    }
}

pub async fn foreground_cwd(shell_pid: i32) -> Option<PathBuf> {
    tokio::task::spawn_blocking(move || match Platform::current() {
        Platform::Linux => linux_foreground_cwd(shell_pid, Path::new("/proc")),
        Platform::Darwin => darwin_foreground_cwd(shell_pid, tool_output),
    })
    .await
    .ok()
    .flatten()
}
