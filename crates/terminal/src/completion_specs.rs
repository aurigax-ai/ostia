use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use ostia_base::js_json::parse_js_json;
use ostia_contract::completion_spec::{
    SPEC_FILE_MAX_BYTES, SpecCommand, is_spec_command, parse_completion_spec,
};
use parking_lot::Mutex;

struct Cached {
    modified: Option<SystemTime>,
    size: u64,
    spec: Option<SpecCommand>,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn parse_spec(path: &Path) -> Option<SpecCommand> {
    let text = String::from_utf8_lossy(&fs::read(path).ok()?).into_owned();
    parse_completion_spec(&parse_js_json(&text).ok()?).ok()
}

fn read_spec(path: &Path) -> Option<SpecCommand> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SPEC_FILE_MAX_BYTES {
        return None;
    }
    let modified = meta.modified().ok();
    let mut cache = CACHE.lock();
    if let Some(hit) = cache.get(path)
        && hit.modified == modified
        && hit.size == meta.len()
    {
        return hit.spec.clone();
    }
    let spec = parse_spec(path);
    cache.insert(
        path.to_path_buf(),
        Cached {
            modified,
            size: meta.len(),
            spec: spec.clone(),
        },
    );
    spec
}

pub fn load_completion_spec(command: &str, dirs: &[PathBuf]) -> Option<SpecCommand> {
    if !is_spec_command(command) {
        return None;
    }
    dirs.iter()
        .find_map(|dir| read_spec(&dir.join(format!("{command}.json"))))
}
