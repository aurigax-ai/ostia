use std::fs;
use std::path::{Path, PathBuf};

fn regular_target(link: &Path) -> Option<PathBuf> {
    if !fs::symlink_metadata(link).ok()?.file_type().is_symlink() {
        return None;
    }
    let target = fs::canonicalize(link).ok()?;
    fs::metadata(&target).ok()?.is_file().then_some(target)
}

pub fn hook_link_targets(home: &Path) -> Vec<PathBuf> {
    let dir = home.join(".claude").join("hooks");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut targets: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if let Some(target) = regular_target(&dir.join(entry.file_name()))
            && !targets.contains(&target)
        {
            targets.push(target);
        }
    }
    targets
}
