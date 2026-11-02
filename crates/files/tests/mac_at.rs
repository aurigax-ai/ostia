#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(target_os = "macos")]

use std::fs::{self, File};
use std::io::ErrorKind;
use std::os::fd::AsFd;
use std::os::unix::fs::symlink;

use ostia_files::at_fs::AtFs;
use ostia_files::mac_at::MacAt;
use tempfile::TempDir;

fn held() -> (TempDir, File) {
    let dir = TempDir::new().unwrap();
    let handle = File::open(dir.path()).unwrap();
    (dir, handle)
}

#[test]
fn lists_reads_links_and_reports_errno_codes_relative_to_a_held_folder() {
    let (dir, handle) = held();
    fs::write(dir.path().join("a.txt"), "a").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    symlink("a.txt", dir.path().join("link")).unwrap();
    let fd = handle.as_fd();

    let mut names = MacAt.list(fd).unwrap();
    names.sort();
    assert_eq!(names, ["a.txt", "link", "sub"]);
    assert_eq!(MacAt.readlinkat(fd, "link").unwrap(), "a.txt");
    assert!(MacAt.lstatat(fd, "link").unwrap().is_symlink());
    assert_eq!(
        MacAt.mkdirat(fd, "sub").unwrap_err().kind(),
        ErrorKind::AlreadyExists
    );
    assert_eq!(
        MacAt.lstatat(fd, "missing").unwrap_err().kind(),
        ErrorKind::NotFound
    );
    assert_eq!(
        MacAt.path_of(fd).unwrap(),
        fs::canonicalize(dir.path()).unwrap().to_string_lossy()
    );
}

#[test]
fn reads_a_long_link_target_whole() {
    let (dir, handle) = held();
    let target = "a".repeat(900);
    symlink(&target, dir.path().join("long")).unwrap();
    assert_eq!(MacAt.readlinkat(handle.as_fd(), "long").unwrap(), target);
}

#[test]
fn keeps_acting_on_the_held_folder_after_it_is_swapped_for_a_link() {
    let (dir, handle) = held();
    let outside = TempDir::new().unwrap();
    let moved = dir.path().with_extension("real");
    fs::rename(dir.path(), &moved).unwrap();
    symlink(outside.path(), dir.path()).unwrap();
    let fd = handle.as_fd();

    MacAt.mkdirat(fd, "made").unwrap();
    assert_eq!(MacAt.list(fd).unwrap(), ["made"]);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(dir.path()).unwrap();
    fs::rename(&moved, dir.path()).unwrap();
}
