use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_fd::dup_fd;
use rustix::fs::{Mode, OFlags};

use crate::at_fs::AtFs;
use crate::transfer_fs::{EntryStat, NodeTransferFs, OpenFile, TransferFs, blocking};

pub const FD_DIR: &str = "/dev/fd";

struct FdEntry {
    fd: i32,
    name: Option<String>,
}

struct Named {
    fd: i32,
    name: String,
}

fn parse(path: &Path) -> Option<FdEntry> {
    let rest = path.to_str()?.strip_prefix(FD_DIR)?.strip_prefix('/')?;
    let mut parts = rest.split('/');
    let fd = parts.next()?;
    let name = parts.next();
    if parts.next().is_some() || fd.is_empty() || !fd.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(FdEntry {
        fd: fd.parse().ok()?,
        name: name.map(str::to_owned),
    })
}

fn named(path: &Path) -> Option<Named> {
    let entry = parse(path)?;
    Some(Named {
        fd: entry.fd,
        name: entry.name?,
    })
}

fn dir(fd: i32) -> io::Result<OwnedFd> {
    dup_fd(fd)
}

#[derive(Clone)]
pub struct AtTransferFs<A> {
    at: Arc<A>,
}

impl<A: AtFs + 'static> AtTransferFs<A> {
    pub fn new(at: A) -> Self {
        Self { at: Arc::new(at) }
    }
}

impl<A: AtFs + 'static> TransferFs for AtTransferFs<A> {
    async fn lstat(&self, path: &Path) -> io::Result<EntryStat> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.lstat(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(fd)?;
        blocking(move || Ok(at.lstatat(folder.as_fd(), &name)?.into())).await
    }

    async fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        let Some(entry) = parse(path) else {
            return NodeTransferFs.readdir(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(entry.fd)?;
        blocking(move || at.list(folder.as_fd())).await
    }

    async fn readlink(&self, path: &Path) -> io::Result<PathBuf> {
        let Some(entry) = parse(path) else {
            return NodeTransferFs.readlink(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(entry.fd)?;
        blocking(move || {
            let target = match &entry.name {
                None => at.path_of(folder.as_fd())?,
                Some(name) => at.readlinkat(folder.as_fd(), name)?,
            };
            Ok(PathBuf::from(target))
        })
        .await
    }

    async fn mkdir(&self, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.mkdir(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(fd)?;
        blocking(move || at.mkdirat(folder.as_fd(), &name)).await
    }

    async fn symlink(&self, target: &Path, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.symlink(target, path).await;
        };
        let at = Arc::clone(&self.at);
        let target = target.to_string_lossy().into_owned();
        let folder = dir(fd)?;
        blocking(move || at.symlinkat(&target, folder.as_fd(), &name)).await
    }

    async fn open(&self, path: &Path, flags: i32, mode: u32) -> io::Result<OpenFile> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.open(path, flags, mode).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(fd)?;
        blocking(move || {
            let opened = at.openat(
                folder.as_fd(),
                &name,
                OFlags::from_bits_retain(flags.cast_unsigned()),
                Mode::from_bits_truncate(mode),
            )?;
            Ok(OpenFile::from_owned(opened))
        })
        .await
    }

    async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let (Some(source), Some(target)) = (named(from), named(to)) else {
            return NodeTransferFs.rename(from, to).await;
        };
        let at = Arc::clone(&self.at);
        let source_dir = dir(source.fd)?;
        let target_dir = dir(target.fd)?;
        blocking(move || {
            at.renameat(
                source_dir.as_fd(),
                &source.name,
                target_dir.as_fd(),
                &target.name,
            )
        })
        .await
    }

    async fn rmdir(&self, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.rmdir(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(fd)?;
        blocking(move || at.unlinkat(folder.as_fd(), &name, true)).await
    }

    async fn unlink(&self, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.unlink(path).await;
        };
        let at = Arc::clone(&self.at);
        let folder = dir(fd)?;
        blocking(move || at.unlinkat(folder.as_fd(), &name, false)).await
    }
}
