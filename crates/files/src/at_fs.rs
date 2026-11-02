use std::io;
use std::os::fd::{BorrowedFd, OwnedFd};

use rustix::fs::{Mode, OFlags};

const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFREG: u32 = 0o100_000;
const S_IFLNK: u32 = 0o120_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryStat {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub uid: u32,
}

impl EntryStat {
    pub fn is_dir(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }

    pub fn is_file(&self) -> bool {
        self.mode & S_IFMT == S_IFREG
    }

    pub fn is_symlink(&self) -> bool {
        self.mode & S_IFMT == S_IFLNK
    }
}

pub trait AtFs: Send + Sync {
    fn openat(
        &self,
        dir: BorrowedFd<'_>,
        name: &str,
        flags: OFlags,
        mode: Mode,
    ) -> io::Result<OwnedFd>;
    fn lstatat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<EntryStat>;
    fn mkdirat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<()>;
    fn symlinkat(&self, target: &str, dir: BorrowedFd<'_>, name: &str) -> io::Result<()>;
    fn readlinkat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<String>;
    fn renameat(
        &self,
        from_dir: BorrowedFd<'_>,
        from: &str,
        to_dir: BorrowedFd<'_>,
        to: &str,
    ) -> io::Result<()>;
    fn unlinkat(&self, dir: BorrowedFd<'_>, name: &str, folder: bool) -> io::Result<()>;
    fn list(&self, dir: BorrowedFd<'_>) -> io::Result<Vec<String>>;
    fn path_of(&self, fd: BorrowedFd<'_>) -> io::Result<String>;
}
