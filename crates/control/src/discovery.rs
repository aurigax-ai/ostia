use std::path::{Path, PathBuf};

use ostia_base::host::Host;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use serde_json::{Value, json};

pub fn control_info_path(host: &Host) -> PathBuf {
    host.app_data_dir().join("control.json")
}

pub fn write_control_info(path: &Path, socket: &Path, pid: u32) {
    let info = json!({ "socket": socket.to_string_lossy(), "pid": pid });
    if let Err(error) = save_json(path, &info, SaveOptions::SECURE) {
        tracing::error!(%error, "could not record the socket path for scripts");
    }
}

fn stored_socket(path: &Path) -> Option<String> {
    load_json(path)?
        .get("socket")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn clear_control_info(path: &Path, socket: &Path) {
    if stored_socket(path).as_deref() != socket.to_str() {
        return;
    }
    let _ = std::fs::remove_file(path);
}

pub fn read_control_socket(path: &Path) -> Option<PathBuf> {
    let socket = PathBuf::from(stored_socket(path).filter(|socket| !socket.is_empty())?);
    socket.exists().then_some(socket)
}

pub fn pane_control_socket(
    env_socket: Option<&str>,
    script_token: bool,
    info_path: &Path,
) -> Option<PathBuf> {
    if let Some(socket) = env_socket {
        return Some(PathBuf::from(socket));
    }
    if script_token {
        read_control_socket(info_path)
    } else {
        None
    }
}
