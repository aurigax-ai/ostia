use std::path::{Path, PathBuf};

use crate::node_path::{self, normal_parts};

pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => node_path::join(home, rest),
        None => PathBuf::from(path),
    }
}

pub fn is_inside_path(base: &Path, path: &Path) -> bool {
    if !base.has_root() || !path.has_root() {
        return false;
    }
    let base = normal_parts(base);
    let path = normal_parts(path);
    path.len() >= base.len() && path[..base.len()] == base[..]
}
