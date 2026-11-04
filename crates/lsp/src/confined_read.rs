use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::node_path::resolve;
use ostia_base::path_guard::is_inside_path;
use ostia_base::regular_file::{RegularFileRead, read_regular_file};

pub fn is_inside_dir(dir: &Path, path: &Path) -> bool {
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = resolve(dir, &cwd);
    let target = resolve(path, &root);
    target != root && is_inside_path(&root, &target)
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
    let real: PathBuf = fs::canonicalize(path).map_err(|_| "unreadable".to_owned())?;
    if !is_inside_dir(root, &real) {
        return Err("outside the extension".to_owned());
    }
    match read_regular_file(&real, max_bytes) {
        RegularFileRead::Ok(data) => Ok(data),
        RegularFileRead::TooLarge => Err(format!("larger than {max_bytes} bytes")),
        RegularFileRead::NotAFile => Err("not a file".to_owned()),
        RegularFileRead::Unreadable | RegularFileRead::Moved => Err("unreadable".to_owned()),
    }
}
