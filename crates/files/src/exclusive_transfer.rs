use std::fs::{self, File, Metadata};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, symlink};
use std::path::{Path, PathBuf};

use ostia_base::node_path;
use ostia_base::{Error, Result};

const MODE_BITS: u32 = 0o777;
const PLACEHOLDER_MODE: u32 = 0o600;

pub trait FolderAnchor: Sized {
    fn path(&self) -> &Path;
    fn dev(&self) -> u64;
    fn at(&self, name: &str) -> Result<PathBuf>;
    fn list(&self) -> Result<Vec<String>>;
    fn child(&self, name: &str, expected: &Metadata) -> Result<Self>;
    fn still_at(&self) -> bool;
}

pub struct TransferEnd<'a, A> {
    pub anchor: &'a A,
    pub name: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyClaim {
    Done,
    Taken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveClaim {
    Done,
    Taken,
    Copy,
}

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("partial")]
    Partial { path: PathBuf },
    #[error("not-copyable")]
    NotCopyable,
    #[error(transparent)]
    Failed(#[from] Error),
}

enum Claim {
    Link,
    File { input: File, output: File },
    Folder { expected: Metadata },
}

enum Claimed {
    Taken,
    Fill(Claim),
}

fn same_entry(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

fn path_of<A: FolderAnchor>(end: &TransferEnd<'_, A>) -> PathBuf {
    node_path::join(end.anchor.path(), end.name)
}

fn io_failure(path: &Path, source: io::Error) -> Error {
    Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn failure(path: &Path, text: &str) -> Error {
    io_failure(path, io::Error::other(text))
}

fn claimed(path: &Path, created: io::Result<()>) -> Result<bool> {
    match created {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(io_failure(path, error)),
    }
}

fn create_exclusive(path: &Path, mode: u32) -> io::Result<File> {
    File::options()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(mode)
        .open(path)
}

fn claim_file(from: &Path, to: &Path, expected: &Metadata) -> Result<Claimed> {
    let input = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(from)
        .map_err(|error| io_failure(from, error))?;
    let info = input.metadata().map_err(|error| io_failure(from, error))?;
    if !info.is_file() || !same_entry(expected, &info) {
        return Err(failure(from, "source-replaced"));
    }
    match create_exclusive(to, info.mode() & MODE_BITS) {
        Ok(output) => Ok(Claimed::Fill(Claim::File { input, output })),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(Claimed::Taken),
        Err(error) => Err(io_failure(to, error)),
    }
}

fn claim_folder<A: FolderAnchor>(
    target: &TransferEnd<'_, A>,
    expected: Metadata,
) -> Result<Claimed> {
    let to = target.anchor.at(target.name)?;
    if !claimed(&to, fs::create_dir(&to))? {
        return Ok(Claimed::Taken);
    }
    Ok(Claimed::Fill(Claim::Folder { expected }))
}

fn claim_target<A: FolderAnchor>(
    source: &TransferEnd<'_, A>,
    target: &TransferEnd<'_, A>,
) -> Result<Option<Claimed>> {
    let from = source.anchor.at(source.name)?;
    let stat = fs::symlink_metadata(&from).map_err(|error| io_failure(&from, error))?;
    if stat.is_symlink() {
        let destination = fs::read_link(&from).map_err(|error| io_failure(&from, error))?;
        let to = target.anchor.at(target.name)?;
        let made = claimed(&to, symlink(destination, &to))?;
        return Ok(Some(if made {
            Claimed::Fill(Claim::Link)
        } else {
            Claimed::Taken
        }));
    }
    if stat.is_dir() {
        return claim_folder(target, stat).map(Some);
    }
    if stat.is_file() {
        let to = target.anchor.at(target.name)?;
        return claim_file(&from, &to, &stat).map(Some);
    }
    Ok(None)
}

fn fill<A: FolderAnchor>(
    claim: Claim,
    source: &TransferEnd<'_, A>,
    target: &TransferEnd<'_, A>,
) -> Result<()> {
    match claim {
        Claim::Link => Ok(()),
        Claim::File {
            mut input,
            mut output,
        } => {
            let from = path_of(source);
            io::copy(&mut input, &mut output)
                .map(|_| ())
                .map_err(|error| io_failure(&from, error))
        }
        Claim::Folder { expected } => {
            let to = target.anchor.at(target.name)?;
            let made = fs::symlink_metadata(&to).map_err(|error| io_failure(&to, error))?;
            let from = source.anchor.child(source.name, &expected)?;
            let into = target.anchor.child(target.name, &made)?;
            copy_children(&from, &into)
        }
    }
}

fn copy_children<A: FolderAnchor>(from: &A, into: &A) -> Result<()> {
    for name in from.list()? {
        let source = TransferEnd {
            anchor: from,
            name: &name,
        };
        let target = TransferEnd {
            anchor: into,
            name: &name,
        };
        match claim_target(&source, &target)? {
            None => {}
            Some(Claimed::Taken) => return Err(failure(&path_of(&target), "exists")),
            Some(Claimed::Fill(claim)) => fill(claim, &source, &target)?,
        }
    }
    Ok(())
}

pub fn copy_exclusive<A: FolderAnchor>(
    source: &TransferEnd<'_, A>,
    target: &TransferEnd<'_, A>,
) -> std::result::Result<CopyClaim, TransferError> {
    let claim = match claim_target(source, target)? {
        None => return Err(TransferError::NotCopyable),
        Some(Claimed::Taken) => return Ok(CopyClaim::Taken),
        Some(Claimed::Fill(claim)) => claim,
    };
    fill(claim, source, target).map_err(|_| TransferError::Partial {
        path: path_of(target),
    })?;
    Ok(CopyClaim::Done)
}

fn placeholder<A: FolderAnchor>(target: &TransferEnd<'_, A>, folder: bool) -> Result<bool> {
    let to = target.anchor.at(target.name)?;
    if folder {
        return claimed(&to, fs::create_dir(&to));
    }
    claimed(&to, create_exclusive(&to, PLACEHOLDER_MODE).map(drop))
}

fn rename_entry<A: FolderAnchor>(
    source: &TransferEnd<'_, A>,
    target: &TransferEnd<'_, A>,
) -> Result<()> {
    let from = source.anchor.at(source.name)?;
    let to = target.anchor.at(target.name)?;
    fs::rename(&from, &to).map_err(|error| io_failure(&from, error))
}

pub fn move_exclusive<A: FolderAnchor>(
    source: &TransferEnd<'_, A>,
    target: &TransferEnd<'_, A>,
) -> std::result::Result<MoveClaim, TransferError> {
    let from = source.anchor.at(source.name)?;
    let info = fs::symlink_metadata(&from).map_err(|error| io_failure(&from, error))?;
    if info.dev() != target.anchor.dev() {
        return Ok(MoveClaim::Copy);
    }
    if !placeholder(target, info.is_dir())? {
        return Ok(MoveClaim::Taken);
    }
    rename_entry(source, target).map_err(|_| TransferError::Partial {
        path: path_of(target),
    })?;
    Ok(MoveClaim::Done)
}

pub fn entry_unchanged<A: FolderAnchor>(end: &TransferEnd<'_, A>, expected: &Metadata) -> bool {
    if !end.anchor.still_at() {
        return false;
    }
    let Ok(path) = end.anchor.at(end.name) else {
        return false;
    };
    fs::symlink_metadata(path).is_ok_and(|now| same_entry(expected, &now))
}
