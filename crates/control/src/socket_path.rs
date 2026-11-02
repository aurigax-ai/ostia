use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_base::private_tmp::{private_run_dir, socket_path};
use ostia_base::{APP_DIR_NAME, Result};

fn control_socket_dir(host: &Host) -> Result<PathBuf> {
    if host.platform == Platform::Darwin {
        return private_run_dir(host, "control");
    }
    Ok(host
        .var("XDG_RUNTIME_DIR")
        .map_or_else(|| host.tmp_dir(), PathBuf::from))
}

pub fn control_socket_path_for(pid: u32, host: &Host) -> Result<PathBuf> {
    socket_path(
        &control_socket_dir(host)?,
        &format!("{APP_DIR_NAME}-{pid}.sock"),
        host.platform,
    )
}
