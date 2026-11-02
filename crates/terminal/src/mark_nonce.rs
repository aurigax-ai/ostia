use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use ostia_base::random::random_bytes;
use serde_json::Value;

const NONCE_BYTES: usize = 16;

pub fn mark_nonce_file_for(state_file: impl AsRef<Path>) -> PathBuf {
    let mut name = OsString::from(state_file.as_ref().as_os_str());
    name.push(".mark");
    PathBuf::from(name)
}

pub fn write_mark_nonce(file: &Path) -> io::Result<String> {
    let nonce = hex::encode(random_bytes::<NONCE_BYTES>());
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?
        .write_all(nonce.as_bytes())?;
    Ok(nonce)
}

pub fn is_mark_nonce(raw: &Value) -> bool {
    raw.as_str().is_some_and(|text| {
        text.len() == NONCE_BYTES * 2
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}
