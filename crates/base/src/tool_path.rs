use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rustix::process::{Pid, Signal, kill_process_group};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

use crate::host::{Host, Platform};
use crate::js::js_trim;
use crate::node_path;

pub const LOGIN_PATH_TIMEOUT_MS: u64 = 5000;

const MARK: &str = "__OSTIA_LOGIN_PATH__";
const DELIMITER: char = ':';

pub type ShellFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

pub type ShellRunner = Arc<dyn Fn(String, Vec<String>, Duration) -> ShellFuture + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct ToolPathEnv {
    pub path: Option<String>,
    pub platform: Option<Platform>,
    pub home: Option<PathBuf>,
}

#[derive(Clone, Default)]
pub struct LoginPathOptions {
    pub shell: Option<String>,
    pub platform: Option<Platform>,
    pub timeout: Option<Duration>,
    pub run: Option<ShellRunner>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginPathResult {
    pub path: Option<String>,
    pub ms: u64,
}

pub fn fallback_dirs(platform: Platform, home: &Path) -> Vec<String> {
    match platform {
        Platform::Darwin => [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ]
        .map(str::to_owned)
        .to_vec(),
        Platform::Linux => vec![
            "/usr/local/bin".to_owned(),
            "/usr/local/sbin".to_owned(),
            node_path::join(home, ".local/bin")
                .to_string_lossy()
                .into_owned(),
            "/home/linuxbrew/.linuxbrew/bin".to_owned(),
            "/snap/bin".to_owned(),
        ],
    }
}

pub fn merge_paths(paths: &[&str]) -> String {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for dir in paths.iter().flat_map(|path| path.split(DELIMITER)) {
        if !dir.is_empty() && seen.insert(dir) {
            merged.push(dir);
        }
    }
    merged.join(":")
}

pub fn parse_login_path(output: &str) -> Option<String> {
    let start = output.find(MARK)?;
    let end = output.rfind(MARK)?;
    if end <= start {
        return None;
    }
    let path = js_trim(&output[start + MARK.len()..end]);
    if path.is_empty() || path.contains(['\r', '\n']) {
        return None;
    }
    Some(path.to_owned())
}

fn user_shell() -> Option<String> {
    let uid = crate::process::current_uid().to_string();
    std::fs::read_to_string("/etc/passwd")
        .ok()?
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            (fields.get(2) == Some(&uid.as_str()))
                .then(|| fields.get(6).map(|shell| (*shell).to_owned()))
                .flatten()
        })
        .find(|shell| !shell.is_empty())
}

fn login_shell(host: &Host) -> String {
    host.var("SHELL")
        .map(str::to_owned)
        .or_else(user_shell)
        .unwrap_or_else(|| {
            if host.platform == Platform::Darwin {
                "/bin/zsh".to_owned()
            } else {
                "/bin/sh".to_owned()
            }
        })
}

fn kill_group(pid: Option<u32>) {
    let pid = pid
        .and_then(|raw| i32::try_from(raw).ok())
        .and_then(Pid::from_raw);
    if let Some(pid) = pid {
        let _ = kill_process_group(pid, Signal::KILL);
    }
}

fn spawn_detached(shell: &str, args: &[String]) -> std::io::Result<tokio::process::Child> {
    let mut command = if cfg!(target_os = "linux") {
        let mut command = Command::new("setsid");
        command.arg(shell);
        command
    } else {
        let mut command = Command::new(shell);
        command.process_group(0);
        command
    };
    command
        .args(args)
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

pub async fn run_login_shell(shell: &str, args: &[String], timeout: Duration) -> String {
    let Ok(mut child) = spawn_detached(shell, args) else {
        return String::new();
    };
    let pid = child.id();
    let Some(mut stdout) = child.stdout.take() else {
        kill_group(pid);
        return String::new();
    };
    let mut output = Vec::new();
    {
        let read = stdout.read_to_end(&mut output);
        tokio::pin!(read);
        let timed_out = tokio::select! {
            _ = &mut read => false,
            () = tokio::time::sleep(timeout) => true,
        };
        if timed_out {
            kill_group(pid);
            let _ = read.await;
        }
    }
    let _ = child.wait().await;
    String::from_utf8_lossy(&output).into_owned()
}

fn default_runner() -> ShellRunner {
    Arc::new(|shell, args, timeout| {
        Box::pin(async move { Ok(run_login_shell(&shell, &args, timeout).await) })
    })
}

#[derive(Default)]
struct LoginState {
    login_path: String,
    pending: Option<watch::Receiver<bool>>,
}

#[derive(Clone)]
pub struct ToolPath {
    host: Host,
    state: Arc<Mutex<LoginState>>,
}

impl ToolPath {
    pub fn new(host: &Host) -> Self {
        Self {
            host: host.clone(),
            state: Arc::default(),
        }
    }

    pub fn tool_path(&self, env: &ToolPathEnv) -> String {
        let platform = env.platform.unwrap_or(self.host.platform);
        let home = env.home.as_deref().unwrap_or(&self.host.home);
        let given = env
            .path
            .clone()
            .or_else(|| self.host.env.get("PATH").cloned())
            .unwrap_or_default();
        let login_path = self.state.lock().login_path.clone();
        merge_paths(&[
            &given,
            &login_path,
            &fallback_dirs(platform, home).join(":"),
        ])
    }

    pub fn resolve_login_path(
        &self,
        options: LoginPathOptions,
    ) -> impl Future<Output = LoginPathResult> + Send + use<> {
        let shell = options.shell.unwrap_or_else(|| login_shell(&self.host));
        let run = options.run.unwrap_or_else(default_runner);
        let timeout = options
            .timeout
            .unwrap_or(Duration::from_millis(LOGIN_PATH_TIMEOUT_MS));
        let started = Instant::now();
        let command = format!("printf '%s' '{MARK}'; printenv PATH; printf '%s' '{MARK}'");
        let running = run(shell, vec!["-ilc".to_owned(), command], timeout);
        let (done, settled) = watch::channel(false);
        self.state.lock().pending = Some(settled);
        let state = Arc::clone(&self.state);
        async move {
            let output = running.await.unwrap_or_default();
            let path = parse_login_path(&output);
            if let Some(found) = &path {
                state.lock().login_path.clone_from(found);
            }
            let _ = done.send(true);
            LoginPathResult {
                path,
                ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            }
        }
    }

    pub async fn login_path_settled(&self) {
        let pending = self.state.lock().pending.clone();
        if let Some(mut pending) = pending {
            let _ = pending.wait_for(|finished| *finished).await;
        }
    }

    pub fn reset(&self) {
        let mut state = self.state.lock();
        state.login_path.clear();
        state.pending = None;
    }
}
