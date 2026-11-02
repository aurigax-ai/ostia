#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_base::path_guard::resolve_safe;
use ostia_contract::files_api::FsBinaryResult;
use ostia_files::fs_binary::{FS_BINARY_MAX, read_binary_confined};
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
        fs::write(
            root.path().join("pixel.png"),
            [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255],
        )
        .unwrap();
        fs::write(root.path().join("big.bin"), vec![0u8; 64]).unwrap();
        fs::write(outside.path().join("secret.bin"), b"secret").unwrap();
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
}

#[test]
fn returns_the_exact_bytes_of_a_file_inside_an_allowed_root() {
    let fixture = Fixture::new();
    let result = read_binary_confined(
        &fixture.in_root("pixel.png"),
        fixture.confine(),
        FS_BINARY_MAX,
    );
    assert_eq!(
        result,
        FsBinaryResult::Ok {
            data: vec![0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]
        }
    );
}

#[test]
fn refuses_a_path_outside_every_allowed_root() {
    let fixture = Fixture::new();
    assert_eq!(
        read_binary_confined(
            &fixture.in_outside("secret.bin"),
            fixture.confine(),
            FS_BINARY_MAX
        ),
        FsBinaryResult::Denied
    );
}

#[test]
fn refuses_a_dot_dot_escape_out_of_the_root() {
    let fixture = Fixture::new();
    let outside_name = fixture
        .outside
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let escaped = format!(
        "{}/../{}/secret.bin",
        fixture.root.path().display(),
        outside_name
    );
    assert_eq!(
        read_binary_confined(&escaped, fixture.confine(), FS_BINARY_MAX),
        FsBinaryResult::Denied
    );
}

#[test]
fn reports_a_file_over_the_size_cap_without_returning_its_bytes() {
    let fixture = Fixture::new();
    assert_eq!(
        read_binary_confined(&fixture.in_root("big.bin"), fixture.confine(), 32),
        FsBinaryResult::TooLarge { size: 64 }
    );
}

#[test]
fn caps_reads_at_50_mib_by_default() {
    assert_eq!(FS_BINARY_MAX, 50 * 1024 * 1024);
}

#[test]
fn reports_directories_and_missing_files_as_unreadable() {
    let fixture = Fixture::new();
    assert_eq!(
        read_binary_confined(&fixture.in_root("dir"), fixture.confine(), FS_BINARY_MAX),
        FsBinaryResult::Unreadable
    );
    assert_eq!(
        read_binary_confined(
            &fixture.in_root("nope.png"),
            fixture.confine(),
            FS_BINARY_MAX
        ),
        FsBinaryResult::Unreadable
    );
}

#[test]
fn follows_a_symlink_inside_the_root_as_the_lexical_fs_guard_documents() {
    let fixture = Fixture::new();
    symlink(
        fixture.root.path().join("pixel.png"),
        fixture.root.path().join("link.png"),
    )
    .unwrap();
    assert!(matches!(
        read_binary_confined(
            &fixture.in_root("link.png"),
            fixture.confine(),
            FS_BINARY_MAX
        ),
        FsBinaryResult::Ok { .. }
    ));
}

#[test]
fn reads_a_file_exactly_at_the_cap() {
    let fixture = Fixture::new();
    assert_eq!(
        read_binary_confined(&fixture.in_root("big.bin"), fixture.confine(), 64),
        FsBinaryResult::Ok {
            data: vec![0u8; 64]
        }
    );
}

#[test]
fn asks_the_confine_function_before_it_touches_the_file_system() {
    let seen = std::sync::Mutex::new(Vec::new());
    let result = read_binary_confined(
        "/nowhere/at/all",
        |path: &str| {
            seen.lock().unwrap().push(path.to_owned());
            None
        },
        FS_BINARY_MAX,
    );
    assert_eq!(result, FsBinaryResult::Denied);
    assert_eq!(*seen.lock().unwrap(), vec!["/nowhere/at/all".to_owned()]);
}
