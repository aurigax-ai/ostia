#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ostia_base::host::{Host, Platform};
use ostia_base::path_guard::resolve_safe;
use ostia_contract::files_api::FsTextResult;
use ostia_files::fs_binary::FS_BINARY_MAX;
use ostia_files::fs_text::{
    FS_TEXT_SNIFF_BYTES, read_text_confined, version_confined, write_text, write_text_confined,
};
use serde_json::{Value, json};
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    outside: TempDir,
    host: Host,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(root.path().join("a.txt"), "héllo\n").unwrap();
        fs::write(root.path().join("big.txt"), "x".repeat(64)).unwrap();
        fs::write(root.path().join("blob.bin"), [0x89, 0x50, 0, 1]).unwrap();
        let mut late = "x".repeat(FS_TEXT_SNIFF_BYTES);
        late.push('\0');
        fs::write(root.path().join("late-nul.txt"), late).unwrap();
        fs::write(root.path().join("locked.txt"), "secret").unwrap();
        fs::set_permissions(
            root.path().join("locked.txt"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        fs::create_dir(root.path().join("dir")).unwrap();
        let host = Host {
            env: BTreeMap::new(),
            home: root.path().join("home"),
            cwd: root.path().to_path_buf(),
            platform: Platform::current(),
        };
        Self {
            root,
            outside,
            host,
        }
    }

    fn confine(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
        let root = self.root.path().to_string_lossy().into_owned();
        move |path| resolve_safe(path, &[root.as_str()], &self.host)
    }

    fn in_root(&self, name: &str) -> String {
        self.root.path().join(name).to_string_lossy().into_owned()
    }

    fn in_outside(&self, name: &str) -> String {
        self.outside
            .path()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn read(&self, name: &str) -> FsTextResult {
        read_text_confined(&json!(self.in_root(name)), self.confine(), FS_BINARY_MAX)
    }

    fn version(&self, path: &str) -> Option<String> {
        version_confined(&json!(path), self.confine())
    }
}

fn saving(text: &'static str) -> impl FnOnce(&Path) -> io::Result<()> {
    move |safe| write_text(safe, text).map(|_| ())
}

#[test]
fn returns_the_utf_8_text_of_a_file_inside_an_allowed_root() {
    let fx = Fixture::new();
    match fx.read("a.txt") {
        FsTextResult::Ok { text, .. } => assert_eq!(text, "héllo\n"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn refuses_a_path_outside_every_allowed_root_and_a_non_string_path() {
    let fx = Fixture::new();
    assert_eq!(
        read_text_confined(
            &json!(fx.in_outside("secret.txt")),
            fx.confine(),
            FS_BINARY_MAX
        ),
        FsTextResult::Denied
    );
    for bad in [json!(42), Value::Null, json!(["a"]), json!({"a": 1})] {
        assert_eq!(
            read_text_confined(&bad, fx.confine(), FS_BINARY_MAX),
            FsTextResult::Denied,
            "{bad}"
        );
    }
}

#[test]
fn reports_a_file_over_the_cap_without_reading_it() {
    let fx = Fixture::new();
    assert_eq!(
        read_text_confined(&json!(fx.in_root("big.txt")), fx.confine(), 32),
        FsTextResult::TooLarge { size: 64 }
    );
}

#[test]
fn reports_a_nul_in_the_first_8_kib_as_binary_and_one_after_it_as_text() {
    let fx = Fixture::new();
    assert_eq!(fx.read("blob.bin"), FsTextResult::Binary);
    assert!(matches!(fx.read("late-nul.txt"), FsTextResult::Ok { .. }));
}

#[test]
fn tells_a_missing_file_apart_from_one_that_cannot_be_read() {
    let fx = Fixture::new();
    assert_eq!(fx.read("nope.txt"), FsTextResult::Missing);
    assert_eq!(fx.read("dir"), FsTextResult::Unreadable);
}

#[test]
fn reports_a_file_without_read_permission_as_unreadable() {
    let fx = Fixture::new();
    if fs::read(fx.root.path().join("locked.txt")).is_ok() {
        return;
    }
    assert_eq!(fx.read("locked.txt"), FsTextResult::Unreadable);
}

#[test]
fn returns_the_same_version_as_fs_version_until_the_file_is_written_again() {
    let fx = Fixture::new();
    let file = fx.in_root("versioned.txt");
    fs::write(&file, "one").unwrap();
    let read = fx.read("versioned.txt");
    let before = fx.version(&file);
    match read {
        FsTextResult::Ok { version, .. } => assert_eq!(Some(version), before),
        other => panic!("{other:?}"),
    }
    std::thread::sleep(Duration::from_millis(20));
    write_text(Path::new(&file), "three").unwrap();
    let after = fx.version(&file);
    assert!(after.is_some());
    assert_ne!(after, before);
}

#[test]
fn has_no_version_for_a_missing_file_a_folder_or_a_path_outside_the_roots() {
    let fx = Fixture::new();
    assert_eq!(fx.version(&fx.in_root("nope.txt")), None);
    assert_eq!(fx.version(&fx.in_root("dir")), None);
    assert_eq!(fx.version(&fx.in_outside("secret.txt")), None);
}

#[test]
fn fs_write_is_confined_to_allowed_roots_blocks_a_path_outside_and_escapes() {
    let fx = Fixture::new();
    let direct = fx.in_outside("direct.txt");
    let escaped = fx
        .root
        .path()
        .join("..")
        .join(fx.outside.path().file_name().unwrap());
    let escaped = escaped.join("escaped.txt").to_string_lossy().into_owned();
    assert!(!write_text_confined(&direct, fx.confine(), saving("x")).unwrap());
    assert!(!write_text_confined(&escaped, fx.confine(), saving("x")).unwrap());
    assert!(!Path::new(&direct).exists());
    assert!(!fx.outside.path().join("escaped.txt").exists());
}

#[test]
fn writes_a_file_inside_an_allowed_root_and_answers_false_when_the_write_fails() {
    let fx = Fixture::new();
    assert!(
        write_text_confined(&fx.in_root("written.txt"), fx.confine(), saving("saved")).unwrap()
    );
    assert_eq!(
        fs::read_to_string(fx.root.path().join("written.txt")).unwrap(),
        "saved"
    );
    assert!(!write_text_confined(&fx.in_root("dir"), fx.confine(), saving("x")).unwrap());
}

#[test]
fn passes_on_an_error_that_is_not_a_file_system_error() {
    let fx = Fixture::new();
    let bug = |_: &Path| -> io::Result<()> { Err(io::Error::other("bug")) };
    let result = write_text_confined(&fx.in_root("bug.txt"), fx.confine(), bug);
    assert_eq!(result.unwrap_err().to_string(), "bug");
}

#[test]
fn decodes_bytes_that_are_not_utf_8_with_the_replacement_character() {
    let fx = Fixture::new();
    fs::write(fx.root.path().join("latin.txt"), [b'a', 0xff, b'b']).unwrap();
    match fx.read("latin.txt") {
        FsTextResult::Ok { text, .. } => assert_eq!(text, "a\u{fffd}b"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn keeps_a_byte_order_mark_in_the_text() {
    let fx = Fixture::new();
    fs::write(fx.root.path().join("bom.txt"), "\u{feff}hi").unwrap();
    match fx.read("bom.txt") {
        FsTextResult::Ok { text, .. } => assert_eq!(text, "\u{feff}hi"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn reports_a_path_below_a_file_as_missing() {
    let fx = Fixture::new();
    assert_eq!(fx.read("a.txt/child"), FsTextResult::Missing);
}

#[test]
fn hands_the_confined_path_and_not_the_given_one_to_save() {
    let fx = Fixture::new();
    let given = fx.root.path().join("sub").join("..").join("normal.txt");
    let given = given.to_string_lossy().into_owned();
    let seen = std::cell::RefCell::new(None);
    let save = |safe: &Path| {
        *seen.borrow_mut() = Some(safe.to_path_buf());
        write_text(safe, "x").map(|_| ())
    };
    assert!(write_text_confined(&given, fx.confine(), save).unwrap());
    assert_eq!(
        seen.into_inner().unwrap(),
        fx.root.path().join("normal.txt")
    );
}

#[test]
fn does_not_call_save_for_a_path_outside_the_roots() {
    let fx = Fixture::new();
    let called = std::cell::Cell::new(false);
    let save = |_: &Path| {
        called.set(true);
        Ok(())
    };
    assert!(!write_text_confined(&fx.in_outside("x.txt"), fx.confine(), save).unwrap());
    assert!(!called.get());
}

#[test]
fn write_text_truncates_an_existing_file_and_returns_the_stamp_of_what_it_wrote() {
    let fx = Fixture::new();
    let file = fx.root.path().join("stamp.txt");
    fs::write(&file, "a much longer earlier text").unwrap();
    let stamp = write_text(&file, "héllo").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "héllo");
    assert_eq!(stamp.size, 6);
    assert!(stamp.ino > 0);
    assert!(stamp.mtime_ms > 0.0);
}

#[test]
fn write_text_creates_the_file_but_not_its_folder() {
    let fx = Fixture::new();
    write_text(&fx.root.path().join("fresh.txt"), "new").unwrap();
    assert_eq!(
        fs::read_to_string(fx.root.path().join("fresh.txt")).unwrap(),
        "new"
    );
    assert!(write_text(&fx.root.path().join("no-such-folder").join("f.txt"), "x").is_err());
    assert!(!fx.root.path().join("no-such-folder").exists());
}
