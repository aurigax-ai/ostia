use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::host::Host;
use ostia_base::js::js_number;
use ostia_base::private_tmp::{private_run_dir, socket_path};
use parking_lot::Mutex;
use rustix::process::{Pid, Signal, kill_process};
use uuid::Uuid;

pub fn codex_socket_dir(host: &Host) -> Result<PathBuf> {
    private_run_dir(host, "codex")
}

pub fn codex_socket_path(host: &Host) -> Result<PathBuf> {
    let dir = codex_socket_dir(host)?;
    socket_path(&dir, &format!("{}.sock", Uuid::new_v4()), host.platform)
}

fn pid_file_of(socket: &Path) -> PathBuf {
    let mut name = socket.as_os_str().to_owned();
    name.push(".pid");
    PathBuf::from(name)
}

fn kill_server(pid_file: &Path) {
    let Ok(bytes) = fs::read(pid_file) else {
        return;
    };
    let pid = js_number(&String::from_utf8_lossy(&bytes));
    if pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(i32::MAX) {
        return;
    }
    let Some(pid) = Pid::from_raw(pid as i32) else {
        return;
    };
    let _ = kill_process(pid, Signal::TERM);
}

#[derive(Clone, Default)]
pub struct CodexSockets {
    sockets: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl CodexSockets {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, external_id: &str, path: PathBuf) {
        self.sockets.lock().insert(external_id.to_owned(), path);
    }

    pub fn socket_of(&self, external_id: &str) -> Option<PathBuf> {
        self.sockets.lock().get(external_id).cloned()
    }

    pub fn forget(&self, external_id: &str) {
        let Some(path) = self.sockets.lock().remove(external_id) else {
            return;
        };
        let pid_file = pid_file_of(&path);
        kill_server(&pid_file);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&pid_file);
    }
}
