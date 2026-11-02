use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use ostia_base::node_path;
use ostia_contract::keep_shells::KEPT_SHELLS_DIR;
use sha2::{Digest, Sha256};

fn short_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes).as_slice())[..16].to_owned()
}

pub fn kept_shells_dir(user_data: &Path) -> PathBuf {
    node_path::join(user_data, KEPT_SHELLS_DIR)
}

pub fn kept_shells_name(user_data: &Path) -> String {
    short_hash(user_data.as_os_str().as_bytes())
}

pub fn kept_host_channel(user_data: &Path, workspace_id: &str) -> PathBuf {
    let seed = format!("{}\0{workspace_id}", kept_shells_name(user_data));
    node_path::join(
        &kept_shells_dir(user_data),
        &format!("host-{}.sock", short_hash(seed.as_bytes())),
    )
}
