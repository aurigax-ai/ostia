#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;

use rustix::fs::{CWD, FileType, Mode, mknodat};

use ostia_base::regular_file::{RegularFileRead, read_regular_file};
use tempfile::tempdir;

#[test]
fn reads_a_plain_file() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let file = root.join("a.txt");
    fs::write(&file, "hello").unwrap();
    assert_eq!(
        read_regular_file(&file, 100),
        RegularFileRead::Ok(b"hello".to_vec())
    );
}

#[test]
fn refuses_a_symlink() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let file = root.join("a.txt");
    fs::write(&file, "hello").unwrap();
    let link = root.join("link.txt");
    symlink(&file, &link).unwrap();
    assert_eq!(read_regular_file(&link, 100), RegularFileRead::Unreadable);
}

#[test]
fn refuses_a_path_that_goes_through_a_symlinked_folder() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir(root.join("real")).unwrap();
    fs::write(root.join("real/a.txt"), "hello").unwrap();
    symlink(root.join("real"), root.join("alias")).unwrap();
    assert_eq!(
        read_regular_file(&root.join("alias/a.txt"), 100),
        RegularFileRead::Moved
    );
}

#[test]
fn refuses_a_folder_and_a_file_over_the_limit_and_a_missing_file() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    assert_eq!(read_regular_file(&root, 100), RegularFileRead::NotAFile);
    let file = root.join("big");
    fs::write(&file, "123456").unwrap();
    assert_eq!(read_regular_file(&file, 5), RegularFileRead::TooLarge);
    assert_eq!(
        read_regular_file(&root.join("none"), 5),
        RegularFileRead::Unreadable
    );
}

#[test]
fn refuses_a_fifo_and_does_not_block_on_it() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let fifo = root.join("pipe");
    mknodat(CWD, &fifo, FileType::Fifo, Mode::RUSR | Mode::WUSR, 0).unwrap();
    assert_eq!(read_regular_file(&fifo, 100), RegularFileRead::NotAFile);
}
