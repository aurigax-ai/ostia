#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(target_os = "linux")]

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsFd;
use std::os::unix::fs::symlink;

use ostia_files::at_fs::AtFs;
use ostia_files::proc_at_fs::ProcAtFs;
use rustix::fs::{Mode, OFlags};
use tempfile::TempDir;

fn held() -> (TempDir, File) {
    let dir = TempDir::new().unwrap();
    let handle = File::open(dir.path()).unwrap();
    (dir, handle)
}

#[test]
fn lists_reads_links_and_reports_errors_relative_to_a_held_folder() {
    let (dir, handle) = held();
    fs::write(dir.path().join("a.txt"), "a").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    symlink("a.txt", dir.path().join("link")).unwrap();
    let fd = handle.as_fd();

    let mut names = ProcAtFs.list(fd).unwrap();
    names.sort();
    assert_eq!(names, ["a.txt", "link", "sub"]);
    assert_eq!(ProcAtFs.readlinkat(fd, "link").unwrap(), "a.txt");
    assert!(ProcAtFs.lstatat(fd, "link").unwrap().is_symlink());
    assert_eq!(
        ProcAtFs.mkdirat(fd, "sub").unwrap_err().kind(),
        ErrorKind::AlreadyExists
    );
    assert_eq!(
        ProcAtFs.lstatat(fd, "missing").unwrap_err().kind(),
        ErrorKind::NotFound
    );
    assert_eq!(
        ProcAtFs.path_of(fd).unwrap(),
        fs::canonicalize(dir.path()).unwrap().to_string_lossy()
    );
}

#[test]
fn reports_a_file_a_folder_and_a_link_by_what_they_are_without_following_the_link() {
    let (dir, handle) = held();
    fs::write(dir.path().join("a.txt"), "a").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    symlink("sub", dir.path().join("to-sub")).unwrap();
    let fd = handle.as_fd();

    let file = ProcAtFs.lstatat(fd, "a.txt").unwrap();
    assert!(file.is_file() && !file.is_dir() && !file.is_symlink());
    let folder = ProcAtFs.lstatat(fd, "sub").unwrap();
    assert!(folder.is_dir() && !folder.is_file() && !folder.is_symlink());
    let link = ProcAtFs.lstatat(fd, "to-sub").unwrap();
    assert!(link.is_symlink() && !link.is_dir());
}

#[test]
fn leaves_out_the_dot_entries_when_it_lists_a_folder() {
    let (_dir, handle) = held();
    assert_eq!(ProcAtFs.list(handle.as_fd()).unwrap(), Vec::<String>::new());
}

#[test]
fn opens_a_file_in_the_held_folder_to_create_write_and_read_it() {
    let (dir, handle) = held();
    let fd = handle.as_fd();
    let created = ProcAtFs
        .openat(
            fd,
            "made.txt",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
            Mode::RUSR | Mode::WUSR,
        )
        .unwrap();
    File::from(created).write_all(b"hello").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("made.txt")).unwrap(),
        "hello"
    );

    let reading = ProcAtFs
        .openat(fd, "made.txt", OFlags::RDONLY, Mode::empty())
        .unwrap();
    let mut text = String::new();
    File::from(reading).read_to_string(&mut text).unwrap();
    assert_eq!(text, "hello");

    let again = ProcAtFs.openat(
        fd,
        "made.txt",
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::RUSR | Mode::WUSR,
    );
    assert_eq!(again.unwrap_err().kind(), ErrorKind::AlreadyExists);
    let missing = ProcAtFs.openat(fd, "missing.txt", OFlags::RDONLY, Mode::empty());
    assert_eq!(missing.unwrap_err().kind(), ErrorKind::NotFound);
}

#[test]
fn makes_a_folder_and_a_link_and_reads_the_link_target_back() {
    let (dir, handle) = held();
    let fd = handle.as_fd();
    ProcAtFs.mkdirat(fd, "made").unwrap();
    ProcAtFs.symlinkat("../elsewhere", fd, "ln").unwrap();
    assert!(dir.path().join("made").is_dir());
    assert_eq!(ProcAtFs.readlinkat(fd, "ln").unwrap(), "../elsewhere");
    assert_eq!(
        ProcAtFs.symlinkat("x", fd, "ln").unwrap_err().kind(),
        ErrorKind::AlreadyExists
    );
}

#[test]
fn renames_between_two_held_folders() {
    let (from_dir, from) = held();
    let (to_dir, to) = held();
    fs::write(from_dir.path().join("a.txt"), "a").unwrap();
    ProcAtFs
        .renameat(from.as_fd(), "a.txt", to.as_fd(), "b.txt")
        .unwrap();
    assert!(!from_dir.path().join("a.txt").exists());
    assert_eq!(
        fs::read_to_string(to_dir.path().join("b.txt")).unwrap(),
        "a"
    );
    let missing = ProcAtFs.renameat(from.as_fd(), "a.txt", to.as_fd(), "c.txt");
    assert_eq!(missing.unwrap_err().kind(), ErrorKind::NotFound);
}

#[test]
fn removes_a_file_or_an_empty_folder_as_asked_and_refuses_the_wrong_kind() {
    let (dir, handle) = held();
    let fd = handle.as_fd();
    fs::write(dir.path().join("a.txt"), "a").unwrap();
    fs::create_dir(dir.path().join("empty")).unwrap();
    fs::create_dir(dir.path().join("full")).unwrap();
    fs::write(dir.path().join("full").join("x"), "x").unwrap();

    assert!(ProcAtFs.unlinkat(fd, "a.txt", true).is_err());
    assert!(ProcAtFs.unlinkat(fd, "empty", false).is_err());
    assert!(ProcAtFs.unlinkat(fd, "full", true).is_err());
    assert!(dir.path().join("a.txt").exists());
    assert!(dir.path().join("empty").exists());
    assert!(dir.path().join("full").exists());

    ProcAtFs.unlinkat(fd, "a.txt", false).unwrap();
    ProcAtFs.unlinkat(fd, "empty", true).unwrap();
    assert!(!dir.path().join("a.txt").exists());
    assert!(!dir.path().join("empty").exists());
    assert_eq!(
        ProcAtFs.unlinkat(fd, "a.txt", false).unwrap_err().kind(),
        ErrorKind::NotFound
    );
}

#[test]
fn removes_a_link_without_touching_its_target() {
    let (dir, handle) = held();
    fs::write(dir.path().join("a.txt"), "a").unwrap();
    symlink("a.txt", dir.path().join("link")).unwrap();
    ProcAtFs.unlinkat(handle.as_fd(), "link", false).unwrap();
    assert!(!dir.path().join("link").exists());
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "a");
}

#[test]
fn keeps_acting_on_the_held_folder_after_it_is_swapped_for_a_link() {
    let (dir, handle) = held();
    let outside = TempDir::new().unwrap();
    let moved = dir.path().with_extension("real");
    fs::rename(dir.path(), &moved).unwrap();
    symlink(outside.path(), dir.path()).unwrap();
    let fd = handle.as_fd();

    ProcAtFs.mkdirat(fd, "made").unwrap();
    assert_eq!(ProcAtFs.list(fd).unwrap(), ["made"]);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(dir.path()).unwrap();
    fs::rename(&moved, dir.path()).unwrap();
}
