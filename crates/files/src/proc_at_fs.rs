use std::fs;
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::MetadataExt;

use rustix::fs::{Mode, OFlags};

use crate::at_fs::{AtFs, EntryStat};

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcAtFs;

fn at(dir: BorrowedFd<'_>, name: &str) -> String {
    format!("/proc/self/fd/{}/{name}", dir.as_raw_fd())
}

impl AtFs for ProcAtFs {
    fn openat(
        &self,
        dir: BorrowedFd<'_>,
        name: &str,
        flags: OFlags,
        mode: Mode,
    ) -> io::Result<OwnedFd> {
        Ok(rustix::fs::open(
            at(dir, name),
            flags | OFlags::CLOEXEC,
            mode,
        )?)
    }

    fn lstatat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<EntryStat> {
        let meta = fs::symlink_metadata(at(dir, name))?;
        Ok(EntryStat {
            dev: meta.dev(),
            ino: meta.ino(),
            mode: meta.mode(),
            uid: meta.uid(),
        })
    }

    fn mkdirat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        fs::create_dir(at(dir, name))
    }

    fn symlinkat(&self, target: &str, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        std::os::unix::fs::symlink(target, at(dir, name))
    }

    fn readlinkat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<String> {
        Ok(fs::read_link(at(dir, name))?.to_string_lossy().into_owned())
    }

    fn renameat(
        &self,
        from_dir: BorrowedFd<'_>,
        from: &str,
        to_dir: BorrowedFd<'_>,
        to: &str,
    ) -> io::Result<()> {
        fs::rename(at(from_dir, from), at(to_dir, to))
    }

    fn unlinkat(&self, dir: BorrowedFd<'_>, name: &str, folder: bool) -> io::Result<()> {
        let path = at(dir, name);
        if folder {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    }

    fn list(&self, dir: BorrowedFd<'_>) -> io::Result<Vec<String>> {
        fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect()
    }

    fn path_of(&self, fd: BorrowedFd<'_>) -> io::Result<String> {
        Ok(fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))?
            .to_string_lossy()
            .into_owned())
    }
}
