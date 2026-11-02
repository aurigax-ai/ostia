use std::io;
use std::os::fd::BorrowedFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_fd::borrow_fd;
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

fn dir(fd: i32) -> io::Result<BorrowedFd<'static>> {
    borrow_fd(fd).ok_or_else(|| io::Error::from_raw_os_error(libc::EBADF))
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
        blocking(move || Ok(at.lstatat(dir(fd)?, &name)?.into())).await
    }

    async fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        let Some(entry) = parse(path) else {
            return NodeTransferFs.readdir(path).await;
        };
        let at = Arc::clone(&self.at);
        blocking(move || at.list(dir(entry.fd)?)).await
    }

    async fn readlink(&self, path: &Path) -> io::Result<PathBuf> {
        let Some(entry) = parse(path) else {
            return NodeTransferFs.readlink(path).await;
        };
        let at = Arc::clone(&self.at);
        blocking(move || {
            let fd = dir(entry.fd)?;
            let target = match &entry.name {
                None => at.path_of(fd)?,
                Some(name) => at.readlinkat(fd, name)?,
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
        blocking(move || at.mkdirat(dir(fd)?, &name)).await
    }

    async fn symlink(&self, target: &Path, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.symlink(target, path).await;
        };
        let at = Arc::clone(&self.at);
        let target = target.to_string_lossy().into_owned();
        blocking(move || at.symlinkat(&target, dir(fd)?, &name)).await
    }

    async fn open(&self, path: &Path, flags: i32, mode: u32) -> io::Result<OpenFile> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.open(path, flags, mode).await;
        };
        let at = Arc::clone(&self.at);
        blocking(move || {
            let opened = at.openat(
                dir(fd)?,
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
        blocking(move || at.renameat(dir(source.fd)?, &source.name, dir(target.fd)?, &target.name))
            .await
    }

    async fn rmdir(&self, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.rmdir(path).await;
        };
        let at = Arc::clone(&self.at);
        blocking(move || at.unlinkat(dir(fd)?, &name, true)).await
    }

    async fn unlink(&self, path: &Path) -> io::Result<()> {
        let Some(Named { fd, name }) = named(path) else {
            return NodeTransferFs.unlink(path).await;
        };
        let at = Arc::clone(&self.at);
        blocking(move || at.unlinkat(dir(fd)?, &name, false)).await
    }
}
