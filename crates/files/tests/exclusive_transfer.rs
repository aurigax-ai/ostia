#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::{self, Metadata};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::{Error, Result};
use ostia_files::exclusive_transfer::{
    CopyClaim, FolderAnchor, MoveClaim, TransferEnd, TransferError, copy_exclusive,
    entry_unchanged, move_exclusive,
};
use rustix::fs::{CWD, FileType, Mode, mknodat};
use tempfile::TempDir;

struct PathAnchor {
    path: PathBuf,
    stat: Metadata,
    dev_shift: u64,
    denied: Arc<Vec<String>>,
}

impl PathAnchor {
    fn open(path: &Path) -> Self {
        Self::build(path, 0, Arc::new(Vec::new()))
    }

    fn on_other_device(path: &Path) -> Self {
        Self::build(path, 1, Arc::new(Vec::new()))
    }

    fn refusing(path: &Path, names: &[&str]) -> Self {
        Self::build(
            path,
            0,
            Arc::new(names.iter().map(|name| (*name).to_owned()).collect()),
        )
    }

    fn build(path: &Path, dev_shift: u64, denied: Arc<Vec<String>>) -> Self {
        let stat = fs::symlink_metadata(path).unwrap();
        assert!(stat.is_dir());
        Self {
            path: path.to_path_buf(),
            stat,
            dev_shift,
            denied,
        }
    }

    fn check(&self) -> Result<()> {
        if self.still_at() {
            Ok(())
        } else {
            Err(replaced(&self.path))
        }
    }
}

fn replaced(path: &Path) -> Error {
    Error::UnsafePath {
        path: path.to_path_buf(),
        reason: "folder-replaced".to_owned(),
    }
}

impl FolderAnchor for PathAnchor {
    fn path(&self) -> &Path {
        &self.path
    }

    fn dev(&self) -> u64 {
        self.stat.dev() + self.dev_shift
    }

    fn at(&self, name: &str) -> Result<PathBuf> {
        self.check()?;
        if self.denied.iter().any(|denied| denied == name) {
            return Err(replaced(&self.path.join(name)));
        }
        Ok(self.path.join(name))
    }

    fn list(&self) -> Result<Vec<String>> {
        self.check()?;
        let mut names: Vec<String> = fs::read_dir(&self.path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        Ok(names)
    }

    fn child(&self, name: &str, expected: &Metadata) -> Result<Self> {
        let path = self.path.join(name);
        let stat = fs::symlink_metadata(&path).map_err(|source| Error::Io {
            path: path.clone(),
            source,
        })?;
        if !stat.is_dir() || stat.dev() != expected.dev() || stat.ino() != expected.ino() {
            return Err(replaced(&path));
        }
        Ok(Self {
            path,
            stat,
            dev_shift: 0,
            denied: self.denied.clone(),
        })
    }

    fn still_at(&self) -> bool {
        fs::symlink_metadata(&self.path)
            .map(|now| now.is_dir() && now.dev() == self.stat.dev() && now.ino() == self.stat.ino())
            .unwrap_or(false)
    }
}

fn end<'a>(anchor: &'a PathAnchor, name: &'a str) -> TransferEnd<'a, PathAnchor> {
    TransferEnd { anchor, name }
}

fn copy_within(dir: &Path, from: &str, to: &str) -> std::result::Result<CopyClaim, TransferError> {
    let anchor = PathAnchor::open(dir);
    copy_exclusive(&end(&anchor, from), &end(&anchor, to))
}

fn move_within(dir: &Path, from: &str, to: &str) -> std::result::Result<MoveClaim, TransferError> {
    let anchor = PathAnchor::open(dir);
    move_exclusive(&end(&anchor, from), &end(&anchor, to))
}

fn mode_of(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + i / 251) % 256) as u8).collect()
}

fn make_fifo(path: &Path) {
    mknodat(CWD, path, FileType::Fifo, Mode::RUSR | Mode::WUSR, 0).unwrap();
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn copies_a_file_with_its_bytes_and_its_permission_bits_but_not_the_special_bits() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("plain.txt"), "payload").unwrap();
    fs::set_permissions(
        dir.path().join("plain.txt"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    fs::write(dir.path().join("setuid"), "x").unwrap();
    fs::set_permissions(
        dir.path().join("setuid"),
        fs::Permissions::from_mode(0o4755),
    )
    .unwrap();
    assert!(matches!(
        copy_within(dir.path(), "plain.txt", "copy.txt"),
        Ok(CopyClaim::Done)
    ));
    assert!(matches!(
        copy_within(dir.path(), "setuid", "setuid-copy"),
        Ok(CopyClaim::Done)
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("copy.txt")).unwrap(),
        "payload"
    );
    assert_eq!(mode_of(&dir.path().join("copy.txt")), 0o640);
    assert_eq!(mode_of(&dir.path().join("setuid-copy")), 0o755);
    assert_eq!(
        fs::read_to_string(dir.path().join("plain.txt")).unwrap(),
        "payload"
    );
}

#[test]
fn copies_a_file_larger_than_one_chunk_byte_for_byte() {
    let dir = TempDir::new().unwrap();
    let bytes = pattern(2 * 1024 * 1024 + 4099);
    fs::write(dir.path().join("big.bin"), &bytes).unwrap();
    assert!(matches!(
        copy_within(dir.path(), "big.bin", "big-copy.bin"),
        Ok(CopyClaim::Done)
    ));
    assert!(fs::read(dir.path().join("big-copy.bin")).unwrap() == bytes);
}

#[test]
fn copies_an_empty_file() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("empty"), "").unwrap();
    assert!(matches!(
        copy_within(dir.path(), "empty", "empty-copy"),
        Ok(CopyClaim::Done)
    ));
    assert_eq!(
        fs::metadata(dir.path().join("empty-copy")).unwrap().len(),
        0
    );
}

#[test]
fn copies_a_link_as_a_link_without_following_it() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("real"), "real").unwrap();
    symlink("real", dir.path().join("to-real")).unwrap();
    symlink("/nonexistent/target", dir.path().join("dangling")).unwrap();
    assert!(matches!(
        copy_within(dir.path(), "to-real", "to-real-copy"),
        Ok(CopyClaim::Done)
    ));
    assert!(matches!(
        copy_within(dir.path(), "dangling", "dangling-copy"),
        Ok(CopyClaim::Done)
    ));
    assert_eq!(
        fs::read_link(dir.path().join("to-real-copy")).unwrap(),
        PathBuf::from("real")
    );
    assert_eq!(
        fs::read_link(dir.path().join("dangling-copy")).unwrap(),
        PathBuf::from("/nonexistent/target")
    );
}

#[test]
fn copies_a_folder_with_every_nested_entry() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("tree");
    fs::create_dir_all(source.join("sub/deeper")).unwrap();
    fs::create_dir(source.join("empty")).unwrap();
    fs::write(source.join("top.txt"), "top").unwrap();
    fs::write(source.join("sub/mid.txt"), "mid").unwrap();
    fs::write(source.join("sub/deeper/low.txt"), "low").unwrap();
    fs::set_permissions(
        source.join("sub/mid.txt"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    symlink("top.txt", source.join("link")).unwrap();
    assert!(matches!(
        copy_within(dir.path(), "tree", "tree-copy"),
        Ok(CopyClaim::Done)
    ));
    let copy = dir.path().join("tree-copy");
    assert_eq!(listing(&copy), vec!["empty", "link", "sub", "top.txt"]);
    assert!(copy.join("empty").is_dir());
    assert_eq!(fs::read_to_string(copy.join("top.txt")).unwrap(), "top");
    assert_eq!(fs::read_to_string(copy.join("sub/mid.txt")).unwrap(), "mid");
    assert_eq!(mode_of(&copy.join("sub/mid.txt")), 0o600);
    assert_eq!(
        fs::read_to_string(copy.join("sub/deeper/low.txt")).unwrap(),
        "low"
    );
    assert_eq!(
        fs::read_link(copy.join("link")).unwrap(),
        PathBuf::from("top.txt")
    );
    assert_eq!(listing(&source), vec!["empty", "link", "sub", "top.txt"]);
}

#[test]
fn copies_between_two_different_folders() {
    let from = TempDir::new().unwrap();
    let into = TempDir::new().unwrap();
    fs::write(from.path().join("a.txt"), "from").unwrap();
    let source = PathAnchor::open(from.path());
    let target = PathAnchor::open(into.path());
    assert!(matches!(
        copy_exclusive(&end(&source, "a.txt"), &end(&target, "b.txt")),
        Ok(CopyClaim::Done)
    ));
    assert_eq!(
        fs::read_to_string(into.path().join("b.txt")).unwrap(),
        "from"
    );
}

#[test]
fn leaves_a_special_file_inside_a_copied_folder_out_of_the_copy() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("tree");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), "a").unwrap();
    make_fifo(&source.join("pipe"));
    fs::write(source.join("z.txt"), "z").unwrap();
    assert!(matches!(
        copy_within(dir.path(), "tree", "tree-copy"),
        Ok(CopyClaim::Done)
    ));
    assert_eq!(
        listing(&dir.path().join("tree-copy")),
        vec!["a.txt", "z.txt"]
    );
}

#[test]
fn refuses_to_copy_a_special_file_by_itself_and_creates_nothing() {
    let dir = TempDir::new().unwrap();
    make_fifo(&dir.path().join("pipe"));
    assert!(matches!(
        copy_within(dir.path(), "pipe", "pipe-copy"),
        Err(TransferError::NotCopyable)
    ));
    assert_eq!(listing(dir.path()), vec!["pipe"]);
}

#[test]
fn never_takes_a_name_that_appeared_after_it_was_picked() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("file"), "new").unwrap();
    fs::create_dir(dir.path().join("folder")).unwrap();
    symlink(dir.path(), dir.path().join("link")).unwrap();
    fs::write(dir.path().join("taken"), "theirs").unwrap();
    for name in ["file", "folder", "link"] {
        assert!(
            matches!(move_within(dir.path(), name, "taken"), Ok(MoveClaim::Taken)),
            "move {name}"
        );
        assert!(
            matches!(copy_within(dir.path(), name, "taken"), Ok(CopyClaim::Taken)),
            "copy {name}"
        );
        assert!(
            fs::symlink_metadata(dir.path().join(name)).is_ok(),
            "{name}"
        );
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("taken")).unwrap(),
        "theirs"
    );
}

#[test]
fn never_takes_a_folder_or_a_link_that_already_holds_the_name() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("file"), "new").unwrap();
    fs::create_dir(dir.path().join("taken-folder")).unwrap();
    fs::write(dir.path().join("taken-folder/keep"), "keep").unwrap();
    symlink("file", dir.path().join("taken-link")).unwrap();
    for name in ["taken-folder", "taken-link"] {
        assert!(
            matches!(copy_within(dir.path(), "file", name), Ok(CopyClaim::Taken)),
            "copy {name}"
        );
        assert!(
            matches!(move_within(dir.path(), "file", name), Ok(MoveClaim::Taken)),
            "move {name}"
        );
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("taken-folder/keep")).unwrap(),
        "keep"
    );
    assert_eq!(listing(&dir.path().join("taken-folder")), vec!["keep"]);
    assert_eq!(fs::read_to_string(dir.path().join("file")).unwrap(), "new");
}

#[test]
fn never_writes_through_a_link_already_at_a_name_it_picked() {
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("victim"), "outside").unwrap();
    fs::write(dir.path().join("source.txt"), "payload").unwrap();
    symlink(outside.path().join("victim"), dir.path().join("copy.txt")).unwrap();
    assert!(matches!(
        copy_within(dir.path(), "source.txt", "copy.txt"),
        Ok(CopyClaim::Taken)
    ));
    assert_eq!(
        fs::read_to_string(outside.path().join("victim")).unwrap(),
        "outside"
    );
}

#[test]
fn never_creates_the_file_behind_a_dangling_link_at_a_name_it_picked() {
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(dir.path().join("source.txt"), "payload").unwrap();
    symlink(outside.path().join("new"), dir.path().join("copy.txt")).unwrap();
    assert!(matches!(
        copy_within(dir.path(), "source.txt", "copy.txt"),
        Ok(CopyClaim::Taken)
    ));
    assert!(!outside.path().join("new").exists());
}

#[test]
fn reports_a_partial_copy_with_the_path_of_the_target_when_filling_fails() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("tree");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), "a").unwrap();
    fs::write(source.join("bad.txt"), "bad").unwrap();
    let anchor = PathAnchor::refusing(dir.path(), &["bad.txt"]);
    match copy_exclusive(&end(&anchor, "tree"), &end(&anchor, "tree-copy")) {
        Err(TransferError::Partial { path }) => assert_eq!(path, dir.path().join("tree-copy")),
        other => panic!("expected a partial copy, got {other:?}"),
    }
    assert!(dir.path().join("tree-copy").is_dir());
    assert!(source.join("bad.txt").exists());
}

#[test]
fn moves_a_file_on_one_device_by_rename() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.txt"), "payload").unwrap();
    fs::set_permissions(dir.path().join("a.txt"), fs::Permissions::from_mode(0o640)).unwrap();
    let before = fs::metadata(dir.path().join("a.txt")).unwrap().ino();
    assert!(matches!(
        move_within(dir.path(), "a.txt", "b.txt"),
        Ok(MoveClaim::Done)
    ));
    assert!(fs::symlink_metadata(dir.path().join("a.txt")).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("b.txt")).unwrap(),
        "payload"
    );
    assert_eq!(mode_of(&dir.path().join("b.txt")), 0o640);
    assert_eq!(
        fs::metadata(dir.path().join("b.txt")).unwrap().ino(),
        before
    );
}

#[test]
fn moves_a_folder_with_its_content_and_a_link_without_following_it() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("tree/sub")).unwrap();
    fs::write(dir.path().join("tree/sub/a.txt"), "a").unwrap();
    symlink("/nonexistent/target", dir.path().join("link")).unwrap();
    assert!(matches!(
        move_within(dir.path(), "tree", "moved"),
        Ok(MoveClaim::Done)
    ));
    assert!(matches!(
        move_within(dir.path(), "link", "moved-link"),
        Ok(MoveClaim::Done)
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("moved/sub/a.txt")).unwrap(),
        "a"
    );
    assert_eq!(listing(dir.path()), vec!["moved", "moved-link"]);
    assert_eq!(
        fs::read_link(dir.path().join("moved-link")).unwrap(),
        PathBuf::from("/nonexistent/target")
    );
}

#[test]
fn hands_a_move_to_another_device_back_as_a_copy_and_touches_nothing() {
    let from = TempDir::new().unwrap();
    let into = TempDir::new().unwrap();
    fs::write(from.path().join("a.txt"), "payload").unwrap();
    fs::create_dir(from.path().join("tree")).unwrap();
    let source = PathAnchor::open(from.path());
    let target = PathAnchor::on_other_device(into.path());
    for name in ["a.txt", "tree"] {
        assert!(
            matches!(
                move_exclusive(&end(&source, name), &end(&target, name)),
                Ok(MoveClaim::Copy)
            ),
            "{name}"
        );
    }
    assert_eq!(listing(into.path()), Vec::<String>::new());
    assert_eq!(listing(from.path()), vec!["a.txt", "tree"]);
    assert_eq!(
        fs::read_to_string(from.path().join("a.txt")).unwrap(),
        "payload"
    );
}

#[test]
fn checks_the_device_before_it_claims_the_name_so_a_taken_name_on_another_device_is_a_copy() {
    let from = TempDir::new().unwrap();
    let into = TempDir::new().unwrap();
    fs::write(from.path().join("a.txt"), "payload").unwrap();
    fs::write(into.path().join("a.txt"), "theirs").unwrap();
    let source = PathAnchor::open(from.path());
    let target = PathAnchor::on_other_device(into.path());
    assert!(matches!(
        move_exclusive(&end(&source, "a.txt"), &end(&target, "a.txt")),
        Ok(MoveClaim::Copy)
    ));
    assert_eq!(
        fs::read_to_string(into.path().join("a.txt")).unwrap(),
        "theirs"
    );
}

#[test]
fn moves_into_a_different_folder_on_the_same_device() {
    let from = TempDir::new().unwrap();
    let into = TempDir::new().unwrap();
    fs::write(from.path().join("a.txt"), "payload").unwrap();
    let source = PathAnchor::open(from.path());
    let target = PathAnchor::open(into.path());
    assert!(matches!(
        move_exclusive(&end(&source, "a.txt"), &end(&target, "b.txt")),
        Ok(MoveClaim::Done)
    ));
    assert_eq!(
        fs::read_to_string(into.path().join("b.txt")).unwrap(),
        "payload"
    );
    assert!(!from.path().join("a.txt").exists());
}

#[test]
fn reports_an_entry_unchanged_until_it_is_replaced_or_removed() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let anchor = PathAnchor::open(dir.path());
    let expected = fs::symlink_metadata(dir.path().join("a.txt")).unwrap();
    assert!(entry_unchanged(&end(&anchor, "a.txt"), &expected));
    fs::rename(dir.path().join("a.txt"), dir.path().join("kept.txt")).unwrap();
    fs::write(dir.path().join("a.txt"), "two").unwrap();
    assert!(!entry_unchanged(&end(&anchor, "a.txt"), &expected));
    fs::remove_file(dir.path().join("a.txt")).unwrap();
    assert!(!entry_unchanged(&end(&anchor, "a.txt"), &expected));
    assert!(!entry_unchanged(&end(&anchor, "never-existed"), &expected));
}

#[test]
fn reports_an_entry_changed_when_its_folder_is_no_longer_at_the_anchor_path() {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join("dest")).unwrap();
    fs::write(root.path().join("dest/a.txt"), "one").unwrap();
    let anchor = PathAnchor::open(&root.path().join("dest"));
    let expected = fs::symlink_metadata(root.path().join("dest/a.txt")).unwrap();
    assert!(entry_unchanged(&end(&anchor, "a.txt"), &expected));
    fs::rename(root.path().join("dest"), root.path().join("dest-real")).unwrap();
    fs::create_dir(root.path().join("dest")).unwrap();
    fs::hard_link(
        root.path().join("dest-real/a.txt"),
        root.path().join("dest/a.txt"),
    )
    .unwrap();
    assert!(!entry_unchanged(&end(&anchor, "a.txt"), &expected));
}
