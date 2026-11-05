use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use parking_lot::Mutex;
use rustix::process::{Pid, Signal, kill_process};
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep};

const SOCKET_WAIT: Duration = Duration::from_millis(5000);
const SOCKET_POLL: Duration = Duration::from_millis(25);

#[derive(Debug, thiserror::Error)]
pub enum SshAgentError {
    #[error("ssh-agent did not start")]
    NotStarted,
    #[error("ssh-agent could not run: {0}")]
    Spawn(std::io::Error),
    #[error("ssh-add could not run: {0}")]
    AddSpawn(std::io::Error),
    #[error("Command failed: ssh-add -q {key}\n{stderr}", key = .key.display())]
    AddFailed { key: PathBuf, stderr: String },
}

pub struct SshAgent {
    pub socket: PathBuf,
    child: Mutex<Option<Child>>,
}

impl SshAgent {
    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().take() else {
            return;
        };
        stop_child(&mut child);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

fn stop_child(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    if let Some(pid) = child
        .id()
        .and_then(|raw| i32::try_from(raw).ok())
        .and_then(Pid::from_raw)
    {
        let _ = kill_process(pid, Signal::TERM);
    }
}

async fn wait_for(path: &Path, child: &mut Child) -> bool {
    let start = Instant::now();
    while start.elapsed() < SOCKET_WAIT {
        if path.exists() {
            return true;
        }
        if !matches!(child.try_wait(), Ok(None)) {
            return false;
        }
        sleep(SOCKET_POLL).await;
    }
    false
}

async fn add_keys(socket: &Path, keys: &[PathBuf]) -> Result<(), SshAgentError> {
    for key in keys {
        let output = Command::new("ssh-add")
            .arg("-q")
            .arg(key)
            .env("SSH_AUTH_SOCK", socket)
            .output()
            .await
            .map_err(SshAgentError::AddSpawn)?;
        if !output.status.success() {
            return Err(SshAgentError::AddFailed {
                key: key.clone(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
    }
    Ok(())
}

pub async fn start_ssh_agent(socket: &Path, keys: &[PathBuf]) -> Result<SshAgent, SshAgentError> {
    let _ = std::fs::remove_file(socket);
    let mut child = Command::new("ssh-agent")
        .arg("-D")
        .arg("-a")
        .arg(socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(SshAgentError::Spawn)?;
    if !wait_for(socket, &mut child).await {
        stop_child(&mut child);
        return Err(SshAgentError::NotStarted);
    }
    if let Err(error) = add_keys(socket, keys).await {
        stop_child(&mut child);
        return Err(error);
    }
    Ok(SshAgent {
        socket: socket.to_path_buf(),
        child: Mutex::new(Some(child)),
    })
}
