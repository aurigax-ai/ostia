use std::path::{Path, PathBuf};

use ostia_base::node_path::join;
use serde_json::Value;

const BUILD_INFO_FILE: &str = "build-info.json";
const ASAR_NAME: &str = "app.asar";

fn dirname(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => path,
    }
}

pub fn build_info_path_at(cli_dir: &Path) -> PathBuf {
    let asar = dirname(dirname(cli_dir));
    if asar.file_name().is_some_and(|name| name == ASAR_NAME) {
        return join(dirname(asar), BUILD_INFO_FILE);
    }
    join(cli_dir, &format!("../{BUILD_INFO_FILE}"))
}

pub fn build_version_at(cli_dir: &Path) -> Option<String> {
    let bytes = std::fs::read(build_info_path_at(cli_dir)).ok()?;
    let info: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    info.get("builtAt").and_then(Value::as_str)?;
    info.get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
}
