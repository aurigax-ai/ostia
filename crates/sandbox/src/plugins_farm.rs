use std::collections::HashSet;
use std::fs::{self, DirBuilder};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, symlink};
use std::path::Path;

use ostia_base::error::{Result, io_error};

const PLUGINS_DATA: &str = "data";

fn listed(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn linked_to(link: &Path, target: &Path) -> bool {
    fs::symlink_metadata(link).is_ok_and(|meta| meta.is_symlink())
        && fs::read_link(link).is_ok_and(|current| current == target)
}

fn remove_any(path: &Path) -> Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => return Ok(()),
    };
    match removed {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(io_error(path)(error)),
        _ => Ok(()),
    }
}

fn link(at: &Path, target: &Path) -> Result<()> {
    if linked_to(at, target) {
        return Ok(());
    }
    remove_any(at)?;
    symlink(target, at).map_err(io_error(at))
}

fn private_dir(path: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(io_error(path))
}

pub fn ensure_plugins_farm(farm: &Path, data: &Path) -> Result<()> {
    private_dir(data)?;
    private_dir(farm)?;
    link(&farm.join(PLUGINS_DATA), data)
}

pub fn link_plugins_farm(farm: &Path, data: &Path, source: &Path) -> Result<()> {
    ensure_plugins_farm(farm, data)?;
    let wanted: HashSet<String> = listed(source)
        .into_iter()
        .filter(|name| name != PLUGINS_DATA)
        .collect();
    for name in listed(farm) {
        if name != PLUGINS_DATA && !wanted.contains(&name) {
            remove_any(&farm.join(name))?;
        }
    }
    for name in &wanted {
        link(&farm.join(name), &source.join(name))?;
    }
    Ok(())
}
