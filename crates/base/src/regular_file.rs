use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub enum RegularFileRead {
    Ok(Vec<u8>),
    Unreadable,
    NotAFile,
    Moved,
    TooLarge,
}

fn open_no_follow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

fn read_opened(file: &File, path: &Path, max_bytes: u64) -> std::io::Result<RegularFileRead> {
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Ok(RegularFileRead::NotAFile);
    }
    let now = fs::metadata(path)?;
    if fs::canonicalize(path)? != path || now.dev() != opened.dev() || now.ino() != opened.ino() {
        return Ok(RegularFileRead::Moved);
    }
    if opened.size() > max_bytes {
        return Ok(RegularFileRead::TooLarge);
    }
    let size = usize::try_from(opened.size()).map_err(std::io::Error::other)?;
    let mut body = vec![0u8; size];
    let mut read = 0;
    while read < body.len() {
        let bytes = file.read_at(&mut body[read..], read as u64)?;
        if bytes == 0 {
            break;
        }
        read += bytes;
    }
    body.truncate(read);
    Ok(RegularFileRead::Ok(body))
}

pub fn read_regular_file(path: &Path, max_bytes: u64) -> RegularFileRead {
    let Ok(file) = open_no_follow(path) else {
        return RegularFileRead::Unreadable;
    };
    read_opened(&file, path, max_bytes).unwrap_or(RegularFileRead::Unreadable)
}
