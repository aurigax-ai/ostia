use std::fs::{self, File, Metadata};
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use ostia_base::js::js_number_text;
use ostia_contract::files_api::FsTextResult;

pub const FS_TEXT_SNIFF_BYTES: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStamp {
    pub ino: u64,
    pub mtime_ms: f64,
    pub size: u64,
}

pub fn stamp_of(info: &Metadata) -> FileStamp {
    FileStamp {
        ino: info.ino(),
        mtime_ms: info.mtime() as f64 * 1000.0 + info.mtime_nsec() as f64 / 1_000_000.0,
        size: info.size(),
    }
}

fn version_of(stamp: &FileStamp) -> String {
    format!(
        "{}:{}:{}",
        stamp.ino,
        js_number_text(stamp.mtime_ms),
        stamp.size
    )
}

fn is_missing(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

fn failure_of(error: &io::Error) -> FsTextResult {
    if is_missing(error) {
        FsTextResult::Missing
    } else {
        FsTextResult::Unreadable
    }
}

pub fn read_text_confined(
    path: &serde_json::Value,
    confine: impl Fn(&str) -> Option<PathBuf>,
    max: u64,
) -> FsTextResult {
    let Some(path) = path.as_str() else {
        return FsTextResult::Denied;
    };
    let Some(safe) = confine(path) else {
        return FsTextResult::Denied;
    };
    let info = match fs::metadata(&safe) {
        Ok(info) => info,
        Err(error) => return failure_of(&error),
    };
    if !info.is_file() {
        return FsTextResult::Unreadable;
    }
    if info.len() > max {
        return FsTextResult::TooLarge { size: info.len() };
    }
    let data = match fs::read(&safe) {
        Ok(data) => data,
        Err(error) => return failure_of(&error),
    };
    if data.len() as u64 > max {
        return FsTextResult::TooLarge {
            size: data.len() as u64,
        };
    }
    if data[..data.len().min(FS_TEXT_SNIFF_BYTES)].contains(&0) {
        return FsTextResult::Binary;
    }
    FsTextResult::Ok {
        text: String::from_utf8_lossy(&data).into_owned(),
        version: version_of(&stamp_of(&info)),
    }
}

pub fn version_confined(
    path: &serde_json::Value,
    confine: impl Fn(&str) -> Option<PathBuf>,
) -> Option<String> {
    let safe = confine(path.as_str()?)?;
    let info = fs::metadata(safe).ok()?;
    info.is_file().then(|| version_of(&stamp_of(&info)))
}

pub fn write_text_confined(
    path: &str,
    confine: impl Fn(&str) -> Option<PathBuf>,
    save: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<bool> {
    let Some(safe) = confine(path) else {
        return Ok(false);
    };
    match save(&safe) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error().is_some() => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn write_text(path: &Path, text: &str) -> io::Result<FileStamp> {
    let mut file = File::create(path)?;
    file.write_all(text.as_bytes())?;
    Ok(stamp_of(&file.metadata()?))
}
