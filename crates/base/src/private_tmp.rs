use std::fs::{self, DirBuilder, Permissions};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::APP_DIR_NAME;
use crate::error::{Error, Result, io_error};
use crate::host::{Host, Platform};
use crate::node_path;
use crate::process::current_uid;

const SHORT_SOCKET_BASE: &str = "/tmp";

pub fn socket_path_limit(platform: Platform) -> usize {
    match platform {
        Platform::Darwin => 103,
        Platform::Linux => 107,
    }
}

fn owned_private_dir(dir: PathBuf, uid: u32) -> Result<PathBuf> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(io_error(&dir))?;
    let meta = fs::symlink_metadata(&dir).map_err(io_error(&dir))?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != uid {
        return Err(Error::UnsafePath {
            reason: format!("not a directory owned by uid {uid}"),
            path: dir,
        });
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(&dir, Permissions::from_mode(0o700)).map_err(io_error(&dir))?;
    }
    Ok(dir)
}

pub fn private_tmp_dir(host: &Host, name: &str) -> Result<PathBuf> {
    let uid = current_uid();
    owned_private_dir(host.tmp_dir().join(format!("{name}-{uid}")), uid)
}

pub fn private_run_dir(host: &Host, name: &str) -> Result<PathBuf> {
    match host.platform {
        Platform::Darwin => {
            owned_private_dir(host.app_data_dir().join("run").join(name), current_uid())
        }
        Platform::Linux => private_tmp_dir(host, &format!("{APP_DIR_NAME}-{name}")),
    }
}

pub fn short_socket_dir() -> Result<PathBuf> {
    let uid = current_uid();
    owned_private_dir(
        Path::new(SHORT_SOCKET_BASE).join(format!("{APP_DIR_NAME}-{uid}")),
        uid,
    )
}

pub fn socket_path(dir: &Path, name: &str, platform: Platform) -> Result<PathBuf> {
    let preferred = node_path::join(dir, name);
    let bytes = preferred.as_os_str().as_bytes();
    if bytes.len() <= socket_path_limit(platform) {
        return Ok(preferred);
    }
    let digest = hex::encode(Sha256::digest(bytes).as_slice());
    Ok(short_socket_dir()?.join(format!("{}-{name}", &digest[..16])))
}
