use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::node_path::{normal_parts, resolve};

fn working_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_default()
}

pub fn is_inside_dir(dir: &Path, path: &Path) -> bool {
    let cwd = working_dir();
    let root = resolve(dir, &cwd);
    let target = resolve(path, &root);
    let root_parts = normal_parts(&root);
    let target_parts = normal_parts(&target);
    if target_parts.len() <= root_parts.len() || target_parts[..root_parts.len()] != root_parts[..]
    {
        return false;
    }
    !target_parts[root_parts.len()]
        .to_string_lossy()
        .starts_with("..")
}

pub fn read_confined(root: &Path, path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    if !is_inside_dir(root, path) {
        return Err("outside the extension".to_owned());
    }
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Err("missing".to_owned());
    };
    if meta.file_type().is_symlink() {
        return Err("symlink refused".to_owned());
    }
    if !meta.is_file() {
        return Err("not a file".to_owned());
    }
    if meta.len() > max_bytes {
        return Err(format!("larger than {max_bytes} bytes"));
    }
    let real = fs::canonicalize(path).map_err(|_| "unreadable".to_owned())?;
    if !is_inside_dir(root, &real) {
        return Err("outside the extension".to_owned());
    }
    fs::read(path).map_err(|_| "unreadable".to_owned())
}
