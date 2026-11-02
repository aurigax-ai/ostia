use std::path::{Path, PathBuf};
use std::time::Duration;

use rustix::fs::{Access, access};

use crate::bounded_run::run_bounded;
use crate::host::{Host, Platform};
use crate::no_new_privs::read_no_new_privs;
use crate::path_lookup::find_on_path;
use crate::pty_relay::read_proc;
use crate::random::random_bytes;

const SERVICE_ENV_KEYS: [&str; 6] = [
    "INVOCATION_ID",
    "JOURNAL_STREAM",
    "NOTIFY_SOCKET",
    "MAINPID",
    "MANAGERPID",
    "SYSTEMD_EXEC_PID",
];

const START_TIMEOUT: Duration = Duration::from_millis(5000);

#[derive(Clone, Debug)]
pub struct SystemdLaunchInput {
    pub platform: Platform,
    pub no_new_privs: bool,
    pub systemd_run: Option<PathBuf>,
    pub tail: Option<PathBuf>,
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub unit: String,
    pub wait_for_pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemdLaunch {
    pub file: PathBuf,
    pub args: Vec<String>,
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn present(path: &Option<PathBuf>) -> Option<&PathBuf> {
    path.as_ref().filter(|path| !path.as_os_str().is_empty())
}

pub fn systemd_launch_plan(input: &SystemdLaunchInput) -> Option<SystemdLaunch> {
    if input.platform != Platform::Linux || !input.no_new_privs {
        return None;
    }
    let systemd_run = present(&input.systemd_run)?;
    let tail = present(&input.tail);
    if input.wait_for_pid.is_some() && tail.is_none() {
        return None;
    }
    let wait = match (input.wait_for_pid, tail) {
        (Some(pid), Some(tail)) => vec![format!(
            "--property=ExecStartPre={} --pid={pid} -f /dev/null",
            tail.display()
        )],
        _ => Vec::new(),
    };
    let setenv = input
        .env
        .iter()
        .filter(|(name, _)| is_env_name(name) && !SERVICE_ENV_KEYS.contains(&name.as_str()))
        .map(|(name, value)| format!("--setenv={name}={value}"));
    let mut args: Vec<String> = ["--user", "--quiet", "--collect", "--no-block"]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
    args.push(format!("--unit={}", input.unit));
    args.push(format!("--working-directory={}", input.cwd.display()));
    args.push("--property=KillMode=process".to_owned());
    args.extend(wait);
    args.extend(setenv);
    args.push("--".to_owned());
    args.push(input.exe.display().to_string());
    args.extend(input.args.iter().cloned());
    Some(SystemdLaunch {
        file: systemd_run.clone(),
        args,
    })
}

fn is_executable(path: &Path) -> bool {
    access(path, Access::EXEC_OK).is_ok()
}

pub fn launch_through_systemd(
    host: &Host,
    exe: &Path,
    args: &[String],
    env: &[(String, String)],
    wait_for_pid: Option<u32>,
) -> bool {
    let path_env = host.env.get("PATH").map_or("", String::as_str);
    let unit = format!("ostia-{}", hex::encode(random_bytes::<6>()));
    let plan = systemd_launch_plan(&SystemdLaunchInput {
        platform: host.platform,
        no_new_privs: read_no_new_privs(host.platform, read_proc),
        systemd_run: find_on_path("systemd-run", path_env, is_executable),
        tail: find_on_path("tail", path_env, is_executable),
        exe: exe.to_path_buf(),
        args: args.to_vec(),
        env: env.to_vec(),
        cwd: host.cwd.clone(),
        unit,
        wait_for_pid,
    });
    plan.is_some_and(|plan| run_bounded(&plan.file, &plan.args, &host.env, START_TIMEOUT).is_some())
}
