#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;

use ostia_fd::{close_fd, dup_fd};

#[test]
fn dup_gives_an_owned_descriptor_that_outlives_the_original() {
    let dir = File::open(".").unwrap();
    let ino = dir.metadata().unwrap().ino();
    let duplicate = dup_fd(dir.as_raw_fd()).unwrap();
    assert_ne!(duplicate.as_raw_fd(), dir.as_raw_fd());
    drop(dir);
    assert_eq!(File::from(duplicate).metadata().unwrap().ino(), ino);
}

#[test]
fn dup_marks_the_descriptor_close_on_exec() {
    let dir = File::open(".").unwrap();
    let duplicate = dup_fd(dir.as_raw_fd()).unwrap();
    let info =
        std::fs::read_to_string(format!("/proc/self/fdinfo/{}", duplicate.as_raw_fd())).unwrap();
    let flags = info
        .lines()
        .find_map(|line| line.strip_prefix("flags:"))
        .unwrap()
        .trim();
    assert_ne!(u64::from_str_radix(flags, 8).unwrap() & 0o2_000_000, 0);
}

#[test]
fn dup_refuses_a_negative_number_and_a_closed_one() {
    assert_eq!(dup_fd(-1).unwrap_err().raw_os_error(), Some(libc::EBADF));
    let closed = 1_000_000;
    assert_eq!(
        dup_fd(closed).unwrap_err().raw_os_error(),
        Some(libc::EBADF)
    );
}

#[test]
fn close_reports_the_error_of_the_close_call() {
    let open = File::open(".").unwrap();
    assert!(close_fd(OwnedFd::from(open)).is_ok());
    let stale = unsafe { OwnedFd::from_raw_fd(1_000_000) };
    assert_eq!(
        close_fd(stale).unwrap_err().raw_os_error(),
        Some(libc::EBADF)
    );
}
