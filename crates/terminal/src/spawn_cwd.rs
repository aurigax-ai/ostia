use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::path_guard::{expand_home, is_inside_path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnFolder {
    pub cwd: PathBuf,
    pub missing: bool,
}

pub fn spawn_folder(cwd: Option<&str>, home: &Path) -> SpawnFolder {
    let Some(cwd) = cwd else {
        return SpawnFolder {
            cwd: home.to_path_buf(),
            missing: false,
        };
    };
    let path = expand_home(cwd, home);
    if path.is_dir() {
        SpawnFolder {
            cwd: path,
            missing: false,
        }
    } else {
        SpawnFolder {
            cwd: home.to_path_buf(),
            missing: true,
        }
    }
}

pub fn sandbox_cwd(cwd: &Path, work_dir: Option<&Path>) -> PathBuf {
    let Some(work_dir) = work_dir.filter(|dir| !dir.as_os_str().is_empty()) else {
        return cwd.to_path_buf();
    };
    match (fs::canonicalize(work_dir), fs::canonicalize(cwd)) {
        (Ok(root), Ok(real)) if is_inside_path(&root, &real) => real,
        _ => work_dir.to_path_buf(),
    }
}
