use std::io;
use std::os::fd::{BorrowedFd, OwnedFd};

use rustix::fs::{AtFlags, Dir, Mode, OFlags};
use rustix::io::Errno;

use crate::at_fs::{AtFs, EntryStat};

const LINK_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Default)]
pub struct MacAt;

impl AtFs for MacAt {
    fn openat(
        &self,
        dir: BorrowedFd<'_>,
        name: &str,
        flags: OFlags,
        mode: Mode,
    ) -> io::Result<OwnedFd> {
        Ok(rustix::fs::openat(
            dir,
            name,
            flags | OFlags::CLOEXEC,
            mode,
        )?)
    }

    fn lstatat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<EntryStat> {
        let stat = rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)?;
        Ok(EntryStat {
            dev: stat.st_dev as u64,
            ino: stat.st_ino,
            mode: u32::from(stat.st_mode),
            uid: stat.st_uid,
        })
    }

    fn mkdirat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        Ok(rustix::fs::mkdirat(dir, name, Mode::from_raw_mode(0o777))?)
    }

    fn symlinkat(&self, target: &str, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        Ok(rustix::fs::symlinkat(target, dir, name)?)
    }

    fn readlinkat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<String> {
        let target = rustix::fs::readlinkat(dir, name, Vec::new())?;
        if target.as_bytes().len() >= LINK_MAX_BYTES {
            return Err(Errno::NAMETOOLONG.into());
        }
        Ok(target.to_string_lossy().into_owned())
    }

    fn renameat(
        &self,
        from_dir: BorrowedFd<'_>,
        from: &str,
        to_dir: BorrowedFd<'_>,
        to: &str,
    ) -> io::Result<()> {
        Ok(rustix::fs::renameat(from_dir, from, to_dir, to)?)
    }

    fn unlinkat(&self, dir: BorrowedFd<'_>, name: &str, folder: bool) -> io::Result<()> {
        let flags = if folder {
            AtFlags::REMOVEDIR
        } else {
            AtFlags::empty()
        };
        Ok(rustix::fs::unlinkat(dir, name, flags)?)
    }

    fn list(&self, dir: BorrowedFd<'_>) -> io::Result<Vec<String>> {
        let listing = rustix::fs::openat(
            dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let mut names = Vec::new();
        for entry in Dir::new(listing)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name != "." && name != ".." {
                names.push(name);
            }
        }
        Ok(names)
    }

    fn path_of(&self, fd: BorrowedFd<'_>) -> io::Result<String> {
        Ok(rustix::fs::getpath(fd)?.to_string_lossy().into_owned())
    }
}
