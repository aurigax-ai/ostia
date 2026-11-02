use std::cmp::Reverse;
use std::collections::{HashSet, VecDeque};
use std::ffi::OsString;
use std::fs::{self, DirBuilder, FileTimes, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ostia_base::js_json::parse_js_json;
use ostia_base::path_guard::is_inside_path;
use tempfile::{Builder, TempDir};

pub const GENERATED_LIST: &str = ".ostia-files";

const LIST_MAX_BYTES: u64 = 1024 * 1024;
const STAGING_PREFIX: &str = ".staging-";

fn make_dirs(path: &Path) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)
}

fn new_staging(root: &Path) -> io::Result<TempDir> {
    Builder::new().prefix(STAGING_PREFIX).tempdir_in(root)
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

pub fn has_files(dir: &Path, names: &[&str]) -> bool {
    names.iter().all(|name| dir.join(name).exists())
}

fn staged_files(staging: &Path) -> io::Result<Vec<String>> {
    let mut queue = VecDeque::from([staging.to_path_buf()]);
    let mut files = Vec::new();
    while let Some(dir) = queue.pop_front() {
        for entry in sorted_entries(&dir)? {
            if entry.file_type()?.is_dir() {
                queue.push_back(entry.path());
            } else if let Ok(relative) = entry.path().strip_prefix(staging) {
                files.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    Ok(files)
}

fn write_list(staging: &Path, names: &[&str]) -> io::Result<()> {
    let mut seen = HashSet::new();
    let listed: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| *name != GENERATED_LIST && seen.insert(*name))
        .collect();
    let text = serde_json::to_string(&listed).map_err(io::Error::other)?;
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(staging.join(GENERATED_LIST))?
        .write_all(text.as_bytes())
}

fn try_record_list(root: &Path, dir: &Path, names: &[&str]) -> io::Result<()> {
    let staging = new_staging(root)?;
    write_list(staging.path(), names)?;
    fs::rename(
        staging.path().join(GENERATED_LIST),
        dir.join(GENERATED_LIST),
    )
}

fn record_list(root: &Path, dir: &Path, names: &[&str]) {
    if dir.join(GENERATED_LIST).exists() {
        return;
    }
    let _ = try_record_list(root, dir, names);
}

fn populate(
    staging: &Path,
    dir: &Path,
    names: &[&str],
    write: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    write(staging)?;
    let written = staged_files(staging)?;
    let mut listed: Vec<&str> = names.to_vec();
    listed.extend(written.iter().map(String::as_str));
    write_list(staging, &listed)?;
    for name in written.iter().map(String::as_str).chain([GENERATED_LIST]) {
        let target = dir.join(name);
        if let Some(parent) = target.parent() {
            make_dirs(parent)?;
        }
        fs::rename(staging.join(name), target)?;
    }
    Ok(())
}

pub fn install_generated(
    root: &Path,
    dir: &Path,
    names: &[&str],
    write: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    make_dirs(root)?;
    if has_files(dir, names) {
        record_list(root, dir, names);
        return Ok(dir.to_path_buf());
    }
    let staging = new_staging(root)?;
    if let Err(error) = populate(staging.path(), dir, names, write)
        && !has_files(dir, names)
    {
        return Err(error);
    }
    Ok(dir.to_path_buf())
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn owned_file(dir: &Path, name: &str) -> Option<PathBuf> {
    if Path::new(name).is_absolute() {
        return None;
    }
    let parts: Vec<&str> = name.split(['\\', '/']).collect();
    if parts.iter().any(|part| matches!(*part, "" | "." | "..")) {
        return None;
    }
    let (last, folders) = parts.split_last()?;
    let mut folder = dir.to_path_buf();
    for part in folders {
        folder.push(part);
        if !is_real_dir(&folder) {
            return None;
        }
    }
    let file = folder.join(last);
    fs::symlink_metadata(&file)
        .is_ok_and(|meta| meta.is_file())
        .then_some(file)
}

fn remove_empty_folders(dir: &Path, stop: &Path) {
    let mut current = dir.to_path_buf();
    while is_inside_path(stop, &current) {
        if fs::remove_dir(&current).is_err() || current == stop {
            return;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return,
        }
    }
}

pub fn remove_generated(dir: &Path, names: &[&str]) {
    if !is_real_dir(dir) {
        return;
    }
    let mut folders = vec![dir.to_path_buf()];
    for name in names.iter().copied().chain([GENERATED_LIST]) {
        let Some(file) = owned_file(dir, name) else {
            continue;
        };
        let _ = fs::remove_file(&file);
        if let Some(parent) = file.parent()
            && !folders.iter().any(|known| known == parent)
        {
            folders.push(parent.to_path_buf());
        }
    }
    folders.sort_by_key(|folder| Reverse(folder.as_os_str().len()));
    for folder in &folders {
        remove_empty_folders(folder, dir);
    }
}

fn read_list(dir: &Path) -> Option<Vec<String>> {
    let file = dir.join(GENERATED_LIST);
    let meta = fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > LIST_MAX_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(&fs::read(&file).ok()?).into_owned();
    parse_js_json(&text)
        .ok()?
        .as_array()?
        .iter()
        .map(|name| name.as_str().map(str::to_owned))
        .collect()
}

pub fn touch_generated(dir: &Path, now: SystemTime) {
    if !is_real_dir(dir) {
        return;
    }
    if let Ok(file) = fs::File::open(dir) {
        let _ = file.set_times(FileTimes::new().set_accessed(now).set_modified(now));
    }
}

pub fn remove_untouched_generations(
    root: &Path,
    keep: &HashSet<PathBuf>,
    untouched_since: SystemTime,
) -> Vec<PathBuf> {
    if !is_real_dir(root) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut entry_names: Vec<OsString> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    entry_names.sort();
    let mut removed = Vec::new();
    for entry in entry_names {
        if entry.as_bytes().first() == Some(&b'.') {
            continue;
        }
        let dir = root.join(&entry);
        if keep.contains(&dir) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified >= untouched_since {
            continue;
        }
        let Some(listed) = read_list(&dir) else {
            continue;
        };
        let names: Vec<&str> = listed.iter().map(String::as_str).collect();
        remove_generated(&dir, &names);
        removed.push(dir);
    }
    removed
}
