use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{Result, io_error};
use crate::host::Host;
use crate::{APP_DIR_NAME, PRODUCT_NAME, node_path};

pub const OLD_PRODUCT_NAME: &str = "pine";

const RUNNING_LOCK: &str = "SingletonLock";

const CHROMIUM_CACHES: [&str; 13] = [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    "Crashpad",
];

const INSTALLED_APP: &str = "app";

const MERGED_FOLDERS: [&str; 1] = ["Partitions"];

fn renamed_entry(entry: &str) -> Option<String> {
    (entry == format!("Partitions/{OLD_PRODUCT_NAME}-browser"))
        .then(|| format!("Partitions/{PRODUCT_NAME}-browser"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirMove {
    pub from: PathBuf,
    pub to: PathBuf,
    pub leave: Vec<String>,
    pub drop: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MoveResult {
    pub moved: Vec<String>,
    pub replaced: Vec<String>,
}

pub type Rename = Box<dyn Fn(&Path, &Path) -> io::Result<()>>;

#[derive(Default)]
pub struct MoveHooks {
    pub rename: Option<Rename>,
}

fn is_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn sorted_names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    names.sort_by(|left, right| compare_utf16(left, right));
    Ok(names)
}

fn holds_data(dir_move: &DirMove) -> bool {
    is_dir(&dir_move.from)
        && sorted_names(&dir_move.from).is_ok_and(|names| {
            names
                .iter()
                .any(|name| !dir_move.leave.contains(name) && !dir_move.drop.contains(name))
        })
}

fn chromium_caches() -> Vec<String> {
    CHROMIUM_CACHES
        .iter()
        .map(|name| (*name).to_owned())
        .collect()
}

pub fn old_dir_moves(app_data: &Path, user_data_overridden: bool, host: &Host) -> Vec<DirMove> {
    let mut config = DirMove {
        from: node_path::join(&host.config_home(), OLD_PRODUCT_NAME),
        to: host.app_config_dir(),
        leave: Vec::new(),
        drop: Vec::new(),
    };
    let data = DirMove {
        from: node_path::join(&host.data_home(), OLD_PRODUCT_NAME),
        to: host.app_data_dir(),
        leave: vec![INSTALLED_APP.to_owned()],
        drop: Vec::new(),
    };
    let mut user_data_move = None;
    if !user_data_overridden {
        let user_data = node_path::join(app_data, OLD_PRODUCT_NAME);
        if user_data == config.from {
            config.drop = chromium_caches();
        } else {
            user_data_move = Some(DirMove {
                from: user_data,
                to: node_path::join(app_data, APP_DIR_NAME),
                leave: Vec::new(),
                drop: chromium_caches(),
            });
        }
    }
    [Some(config), Some(data), user_data_move]
        .into_iter()
        .flatten()
        .filter(holds_data)
        .collect()
}

pub fn saved_workspace_folders(files: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    let home_text = home.to_string_lossy();
    let mut seen = HashSet::new();
    let mut folders = Vec::new();
    for file in files {
        let Ok(bytes) = fs::read(file) else { continue };
        let Ok(saved) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
            continue;
        };
        let Some(workspaces) = saved.get("workspaces").and_then(Value::as_array) else {
            continue;
        };
        for workspace in workspaces {
            let Some(work_dir) = workspace
                .get("workDir")
                .and_then(Value::as_str)
                .filter(|dir| !dir.is_empty())
            else {
                continue;
            };
            let expanded = if work_dir == "~" {
                home_text.clone().into_owned()
            } else if let Some(rest) = work_dir.strip_prefix("~/") {
                format!("{home_text}/{rest}")
            } else {
                work_dir.to_owned()
            };
            if seen.insert(expanded.clone()) {
                folders.push(PathBuf::from(expanded));
            }
        }
    }
    folders
}

pub fn project_dir_moves(folders: &[PathBuf]) -> Vec<DirMove> {
    folders
        .iter()
        .map(|folder| DirMove {
            from: node_path::join(folder, &format!(".{OLD_PRODUCT_NAME}")),
            to: node_path::join(folder, &format!(".{PRODUCT_NAME}")),
            leave: Vec::new(),
            drop: Vec::new(),
        })
        .filter(holds_data)
        .collect()
}

pub fn old_app_running(moves: &[DirMove]) -> bool {
    moves
        .iter()
        .any(|dir_move| present(&dir_move.from.join(RUNNING_LOCK)))
}

fn remove_all(path: &Path) -> Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(err) => Err(err),
    };
    match removed {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err).map_err(io_error(path)),
        _ => Ok(()),
    }
}

fn copy_timestamps(from: &fs::Metadata, to: &Path) -> io::Result<()> {
    let times = fs::FileTimes::new()
        .set_accessed(from.accessed()?)
        .set_modified(from.modified()?);
    fs::File::open(to)?.set_times(times)
}

fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)
    } else if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let name = entry?.file_name();
            copy_recursive(&from.join(&name), &to.join(&name))?;
        }
        fs::set_permissions(to, meta.permissions())?;
        copy_timestamps(&meta, to)
    } else if meta.is_file() {
        fs::copy(from, to)?;
        copy_timestamps(&meta, to)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file, folder or link",
        ))
    }
}

fn move_entry(
    from: &Path,
    to: &Path,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<()> {
    match rename(from, to) {
        Ok(()) => Ok(()),
        Err(err) if err.raw_os_error() == Some(libc::EXDEV) => {
            copy_recursive(from, to).map_err(io_error(from))?;
            remove_all(from)
        }
        Err(err) => Err(err).map_err(io_error(from)),
    }
}

type RenameFn = dyn Fn(&Path, &Path) -> io::Result<()>;

fn move_into(
    from: &Path,
    to: &Path,
    prefix: &str,
    dir_move: &DirMove,
    result: &mut MoveResult,
    rename: Option<&RenameFn>,
) -> Result<()> {
    if rename.is_some() {
        let mode = fs::symlink_metadata(from)
            .map_err(io_error(from))?
            .permissions()
            .mode()
            & 0o777;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(mode)
            .create(to)
            .map_err(io_error(to))?;
    }
    for name in sorted_names(from).map_err(io_error(from))? {
        let entry = format!("{prefix}{name}");
        let path = from.join(&name);
        if dir_move.leave.contains(&entry) {
            continue;
        }
        if dir_move.drop.contains(&entry) {
            if rename.is_some() {
                remove_all(&path)?;
            }
            continue;
        }
        let renamed = renamed_entry(&entry).unwrap_or_else(|| entry.clone());
        let target = node_path::join(to, renamed.get(prefix.len()..).unwrap_or(&renamed));
        if MERGED_FOLDERS.contains(&entry.as_str()) && is_dir(&path) {
            move_into(
                &path,
                &target,
                &format!("{entry}/"),
                dir_move,
                result,
                rename,
            )?;
            if rename.is_some() {
                remove_all(&path)?;
            }
            continue;
        }
        if present(&target) {
            result.replaced.push(entry);
            if rename.is_some() {
                remove_all(&path)?;
            }
            continue;
        }
        if let Some(rename) = rename {
            move_entry(&path, &target, rename)?;
        }
        result.moved.push(entry);
    }
    Ok(())
}

pub fn preview_old_dir(dir_move: &DirMove) -> Result<MoveResult> {
    let mut result = MoveResult::default();
    move_into(
        &dir_move.from,
        &dir_move.to,
        "",
        dir_move,
        &mut result,
        None,
    )?;
    Ok(result)
}

pub fn move_old_dir(dir_move: &DirMove, hooks: MoveHooks) -> Result<MoveResult> {
    let mut result = MoveResult::default();
    let default_rename = |from: &Path, to: &Path| fs::rename(from, to);
    let rename: &dyn Fn(&Path, &Path) -> io::Result<()> = match &hooks.rename {
        Some(custom) => custom.as_ref(),
        None => &default_rename,
    };
    move_into(
        &dir_move.from,
        &dir_move.to,
        "",
        dir_move,
        &mut result,
        Some(rename),
    )?;
    if dir_move.from.exists()
        && sorted_names(&dir_move.from)
            .map_err(io_error(&dir_move.from))?
            .is_empty()
    {
        fs::remove_dir(&dir_move.from).map_err(io_error(&dir_move.from))?;
    }
    Ok(result)
}
