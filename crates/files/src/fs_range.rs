use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::{Error, Result};

pub const RANGE_CHUNK_MAX: usize = 1024 * 1024;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug)]
pub struct RangeReader {
    path: PathBuf,
    file: Option<Arc<File>>,
    size: u64,
    position: u64,
    end: u64,
}

#[derive(Debug)]
pub enum FsRangeResult {
    Ok { reader: RangeReader },
    Denied,
    Unreadable,
    Unsatisfiable,
}

impl RangeReader {
    pub fn size(&self) -> u64 {
        self.size
    }

    pub async fn read(&mut self) -> Result<Option<Vec<u8>>> {
        let Some(file) = self.file.clone() else {
            return Ok(None);
        };
        if self.position > self.end {
            return Ok(None);
        }
        let length = (RANGE_CHUNK_MAX as u64).min(self.end - self.position + 1) as usize;
        let position = self.position;
        let read = tokio::task::spawn_blocking(move || {
            let mut buffer = vec![0u8; length];
            let bytes_read = file.read_at(&mut buffer, position)?;
            Ok::<_, io::Error>((buffer, bytes_read))
        })
        .await
        .map_err(|error| Error::Task(error.to_string()))?;
        let (buffer, bytes_read) = read.map_err(|source| Error::Io {
            path: self.path.clone(),
            source,
        })?;
        if bytes_read < length {
            self.close().await;
            return Err(Error::Io {
                path: self.path.clone(),
                source: io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "file shrank while it was read",
                ),
            });
        }
        self.position += length as u64;
        Ok(Some(buffer))
    }

    pub async fn close(&mut self) {
        self.file = None;
    }
}

fn open_range(safe: &Path, start: u64, end: u64) -> FsRangeResult {
    let Ok(listed) = fs::symlink_metadata(safe) else {
        return FsRangeResult::Unreadable;
    };
    if !listed.is_file() {
        return FsRangeResult::Unreadable;
    }
    let Ok(file) = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(safe)
    else {
        return FsRangeResult::Unreadable;
    };
    let Ok(opened) = file.metadata() else {
        return FsRangeResult::Unreadable;
    };
    if !opened.is_file() || opened.dev() != listed.dev() || opened.ino() != listed.ino() {
        return FsRangeResult::Unreadable;
    }
    if end >= opened.len() {
        return FsRangeResult::Unsatisfiable;
    }
    FsRangeResult::Ok {
        reader: RangeReader {
            path: safe.to_path_buf(),
            file: Some(Arc::new(file)),
            size: opened.len(),
            position: start,
            end,
        },
    }
}

pub async fn read_range_confined(
    path: &str,
    start: i64,
    end: i64,
    confine: impl Fn(&str) -> Option<PathBuf>,
) -> FsRangeResult {
    let Some(safe) = confine(path) else {
        return FsRangeResult::Denied;
    };
    let safe_bound = |value: i64| value.unsigned_abs() <= MAX_SAFE_INTEGER;
    if !safe_bound(start) || !safe_bound(end) || start < 0 || end < start {
        return FsRangeResult::Unsatisfiable;
    }
    let (start, end) = (start as u64, end as u64);
    tokio::task::spawn_blocking(move || open_range(&safe, start, end))
        .await
        .unwrap_or(FsRangeResult::Unreadable)
}
