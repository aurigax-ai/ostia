use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::js_json::parse_js_json;
use ostia_contract::completion_spec::{
    SPEC_FILE_MAX_BYTES, SpecCommand, is_spec_command, parse_completion_spec,
};

fn read_spec(path: &Path) -> Option<SpecCommand> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SPEC_FILE_MAX_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(&fs::read(path).ok()?).into_owned();
    parse_completion_spec(&parse_js_json(&text).ok()?).ok()
}

pub fn load_completion_spec(command: &str, dirs: &[PathBuf]) -> Option<SpecCommand> {
    if !is_spec_command(command) {
        return None;
    }
    dirs.iter()
        .find_map(|dir| read_spec(&dir.join(format!("{command}.json"))))
}
