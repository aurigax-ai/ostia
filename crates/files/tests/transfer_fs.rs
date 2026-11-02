#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_files::transfer_fs::{NodeTransferFs, TransferFs};
use tempfile::TempDir;

fn dir() -> TempDir {
    tempfile::tempdir().unwrap()
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn lstat_describes_a_file_a_folder_and_a_symlink_without_following_it() {
    let tmp = dir();
    let file = tmp.path().join("f");
    write(&file, "x");
    let link = tmp.path().join("l");
    std::os::unix::fs::symlink(&file, &link).unwrap();
    let fs = NodeTransferFs;
    let file_stat = fs.lstat(&file).await.unwrap();
    assert!(file_stat.is_file() && !file_stat.is_directory() && !file_stat.is_symbolic_link());
    let dir_stat = fs.lstat(tmp.path()).await.unwrap();
    assert!(dir_stat.is_directory() && !dir_stat.is_file());
    let link_stat = fs.lstat(&link).await.unwrap();
    assert!(link_stat.is_symbolic_link() && !link_stat.is_file());
    assert!(fs.lstat(&tmp.path().join("missing")).await.is_err());
}

#[tokio::test]
async fn readdir_lists_entry_names_only() {
    let tmp = dir();
    write(&tmp.path().join("a"), "");
    std::fs::create_dir(tmp.path().join("b")).unwrap();
    let fs = NodeTransferFs;
    let mut names = fs.readdir(tmp.path()).await.unwrap();
    names.sort();
    assert_eq!(names, ["a", "b"]);
    assert!(fs.readdir(&tmp.path().join("missing")).await.is_err());
}

#[tokio::test]
async fn mkdir_makes_one_level_and_fails_for_an_existing_or_nested_target() {
    let tmp = dir();
    let fs = NodeTransferFs;
    fs.mkdir(&tmp.path().join("one")).await.unwrap();
    assert!(tmp.path().join("one").is_dir());
    assert!(fs.mkdir(&tmp.path().join("one")).await.is_err());
    assert!(fs.mkdir(&tmp.path().join("a/b")).await.is_err());
}

#[tokio::test]
async fn symlink_and_readlink_keep_the_target_text() {
    let tmp = dir();
    let link = tmp.path().join("l");
    let fs = NodeTransferFs;
    fs.symlink(Path::new("../relative/target"), &link)
        .await
        .unwrap();
    assert_eq!(
        fs.readlink(&link).await.unwrap(),
        Path::new("../relative/target")
    );
    assert!(fs.symlink(Path::new("x"), &link).await.is_err());
    assert!(fs.readlink(&tmp.path().join("missing")).await.is_err());
}

#[tokio::test]
async fn open_creates_a_file_with_the_given_flags_and_mode_and_refuses_an_existing_one_with_excl() {
    let tmp = dir();
    let path = tmp.path().join("new");
    let fs = NodeTransferFs;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL;
    let mut file = fs.open(&path, flags, 0o600).await.unwrap();
    file.write_all(b"hello").await.unwrap();
    file.close().await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    let mode =
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions());
    assert_eq!(mode & 0o777 & !0o077, 0o600);
    assert_eq!(mode & 0o077, 0);
    assert!(fs.open(&path, flags, 0o600).await.is_err());
}

#[tokio::test]
async fn open_reads_an_existing_file_and_reports_its_stat() {
    let tmp = dir();
    let path = tmp.path().join("f");
    write(&path, "abc");
    let fs = NodeTransferFs;
    let mut file = fs.open(&path, libc::O_RDONLY, 0).await.unwrap();
    let stat = file.stat().await.unwrap();
    assert!(stat.is_file());
    assert_eq!(file.read_to_end().await.unwrap(), b"abc");
    file.close().await.unwrap();
    assert!(
        fs.open(&tmp.path().join("missing"), libc::O_RDONLY, 0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn rename_moves_a_file_and_rmdir_and_unlink_remove_only_their_own_kind() {
    let tmp = dir();
    let from = tmp.path().join("from");
    let to = tmp.path().join("to");
    write(&from, "x");
    let fs = NodeTransferFs;
    fs.rename(&from, &to).await.unwrap();
    assert!(!from.exists() && to.exists());
    assert!(fs.rmdir(&to).await.is_err());
    fs.unlink(&to).await.unwrap();
    assert!(!to.exists());
    let folder = tmp.path().join("d");
    std::fs::create_dir(&folder).unwrap();
    assert!(fs.unlink(&folder).await.is_err());
    fs.rmdir(&folder).await.unwrap();
    assert!(!folder.exists());
    write(&tmp.path().join("busy"), "");
    std::fs::create_dir(tmp.path().join("full")).unwrap();
    write(&tmp.path().join("full/x"), "");
    assert!(fs.rmdir(&tmp.path().join("full")).await.is_err());
}
