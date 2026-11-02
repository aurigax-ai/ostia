use std::path::{Path, PathBuf};

use crate::node_path;

pub fn find_on_path(
    program: &str,
    path_env: &str,
    is_executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    path_env
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| node_path::join(Path::new(dir), program))
        .find(|candidate| is_executable(candidate))
}
