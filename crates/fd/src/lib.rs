use std::io;
use std::os::fd::{FromRawFd, IntoRawFd, OwnedFd, RawFd};

pub fn dup_fd(raw: RawFd) -> io::Result<OwnedFd> {
    if raw < 0 {
        return Err(io::Error::from_raw_os_error(libc::EBADF));
    }
    let duplicate = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

pub fn close_fd(fd: OwnedFd) -> io::Result<()> {
    if unsafe { libc::close(fd.into_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
