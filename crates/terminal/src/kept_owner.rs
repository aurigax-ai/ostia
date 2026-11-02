use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::clock::now_ms;
use ostia_base::error::io_error;
use ostia_base::js_json::parse_js_json;
use ostia_base::{Error, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeptOwner {
    pub pid: i64,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
}

static CURRENT_OWNER: LazyLock<KeptOwner> = LazyLock::new(|| KeptOwner {
    pid: i64::from(std::process::id()),
    started_at: now_ms(),
});

pub fn current_owner() -> KeptOwner {
    CURRENT_OWNER.clone()
}

pub fn kept_owner_file(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.owner.json"))
}

pub fn write_kept_owner(file: &Path, owner: &KeptOwner) -> Result<()> {
    let mut partial = file.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let text = serde_json::to_string(owner).map_err(|source| Error::Json {
        path: partial.clone(),
        source,
    })?;
    let mut handle = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)
        .map_err(io_error(&partial))?;
    handle
        .write_all(text.as_bytes())
        .map_err(io_error(&partial))?;
    drop(handle);
    fs::rename(&partial, file).map_err(io_error(file))
}

fn positive_integer(raw: Option<&Value>) -> Option<i64> {
    let value = raw?.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value > 0.0).then_some(value as i64)
}

pub fn read_kept_owner(file: &Path) -> Option<KeptOwner> {
    let bytes = fs::read(file).ok()?;
    let raw = parse_js_json(&String::from_utf8_lossy(&bytes)).ok()?;
    Some(KeptOwner {
        pid: positive_integer(raw.get("pid"))?,
        started_at: positive_integer(raw.get("startedAt"))?,
    })
}

pub fn same_owner(a: Option<&KeptOwner>, b: &KeptOwner) -> bool {
    a.is_some_and(|a| a == b)
}
