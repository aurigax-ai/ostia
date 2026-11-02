use std::path::{Path, PathBuf};

use ostia_contract::build_info::{BuildInfo, parse_build_info};

pub fn read_build_info(path: &Path) -> Option<BuildInfo> {
    parse_build_info(&ostia_base::json_store::load_json(path)?)
}

pub fn packaged_build_info_path(resources: &Path) -> PathBuf {
    resources.join("build-info.json")
}
