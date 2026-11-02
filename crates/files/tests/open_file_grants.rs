#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use ostia_base::host::{Host, Platform};
use ostia_contract::archive_paths::archive_root;
use ostia_contract::open_files::{OpenFileError, OpenFileVerdict};
use ostia_files::open_file_grants::{AdmitOptions, OpenFileGrants, OpenFileGrantsDeps};
use serde_json::{Value, json};
use tempfile::TempDir;

const HUMAN: AdmitOptions = AdmitOptions {
    sandboxed: false,
    remember: true,
};

struct Fixture {
    _dir: TempDir,
    base: PathBuf,
    home: PathBuf,
    outside: PathBuf,
    store: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        let outside = base.join("outside");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::create_dir(outside.join("folder")).unwrap();
        fs::write(home.join("notes.md"), "home").unwrap();
        fs::write(outside.join("app.log"), "log").unwrap();
        fs::write(outside.join("other.log"), "other").unwrap();
        let store = base.join("data").join("opened-files.json");
        Self {
            _dir: dir,
            base,
            home,
            outside,
            store,
        }
    }

    fn host(&self) -> Host {
        Host {
            env: BTreeMap::new(),
            home: self.home.clone(),
            cwd: self.base.clone(),
            platform: Platform::Linux,
        }
    }

    fn grants_with_roots(&self, roots: Vec<String>, max: Option<usize>) -> OpenFileGrants {
        OpenFileGrants::new(OpenFileGrantsDeps {
            roots: Box::new(move || roots.clone()),
            file: self.store.clone(),
            max,
            host: self.host(),
        })
    }

    fn grants_capped(&self, max: Option<usize>) -> OpenFileGrants {
        self.grants_with_roots(vec![text(&self.home)], max)
    }

    fn grants(&self) -> OpenFileGrants {
        self.grants_capped(None)
    }

    fn remembered(&self) -> Vec<String> {
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(&self.store).unwrap()).unwrap();
        stored["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| path.as_str().unwrap().to_owned())
            .collect()
    }

    fn store_missing(&self) -> bool {
        fs::read(&self.store).is_err()
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn admitted(path: &Path) -> OpenFileVerdict {
    OpenFileVerdict::Admitted { path: text(path) }
}

fn refused(path: &Path, error: OpenFileError) -> OpenFileVerdict {
    OpenFileVerdict::Refused {
        path: text(path),
        error,
    }
}

fn refusal(verdict: &OpenFileVerdict) -> Option<OpenFileError> {
    match verdict {
        OpenFileVerdict::Refused { error, .. } => Some(*error),
        OpenFileVerdict::Admitted { .. } => None,
    }
}

#[test]
fn opens_a_file_outside_every_root_and_lets_the_viewer_read_exactly_that_file() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = fx.outside.join("app.log");
    assert_eq!(grants.confine(&text(&file)), None);

    assert_eq!(grants.admit(&text(&file), HUMAN).unwrap(), admitted(&file));

    assert_eq!(grants.confine(&text(&file)), Some(text(&file)));
    assert_eq!(grants.confine(&text(&fx.outside.join("other.log"))), None);
    assert_eq!(grants.confine(&text(&fx.outside)), None);
}

#[test]
fn never_confines_an_archive_path_even_with_the_working_folder_as_a_root() {
    let fx = Fixture::new();
    let cwd_root = fx.grants_with_roots(vec![text(&fx.base)], None);
    let path = format!("{}/passwd", archive_root("/etc/archive.zip"));
    assert_eq!(cwd_root.confine(&path), None);
}

#[test]
fn passes_a_file_inside_a_root_through_without_granting_or_resolving_it() {
    let fx = Fixture::new();
    let grants = fx.grants();
    symlink(fx.home.join("notes.md"), fx.home.join("link.md")).unwrap();

    assert_eq!(
        grants
            .admit(&text(&fx.home.join("link.md")), HUMAN)
            .unwrap(),
        admitted(&fx.home.join("link.md"))
    );
    assert_eq!(
        grants.admit(&text(&fx.home.join("new.md")), HUMAN).unwrap(),
        admitted(&fx.home.join("new.md"))
    );
    assert!(fx.store_missing());
}

#[test]
fn grants_the_file_a_symlink_points_to_never_the_link() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let link = fx.outside.join("latest.log");
    symlink(fx.outside.join("app.log"), &link).unwrap();

    assert_eq!(
        grants.admit(&text(&link), HUMAN).unwrap(),
        admitted(&fx.outside.join("app.log"))
    );

    assert_eq!(grants.confine(&text(&link)), None);
    assert_eq!(
        grants.confine(&text(&fx.outside.join("app.log"))),
        Some(text(&fx.outside.join("app.log")))
    );
}

#[test]
fn needs_no_grant_when_an_outside_link_points_into_a_root() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let link = fx.outside.join("to-home.md");
    symlink(fx.home.join("notes.md"), &link).unwrap();

    assert_eq!(
        grants.admit(&text(&link), HUMAN).unwrap(),
        admitted(&fx.home.join("notes.md"))
    );
    assert!(fx.store_missing());
}

#[test]
fn refuses_a_folder_inside_or_outside_the_roots() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let folder = fx.outside.join("folder");
    assert_eq!(
        grants.admit(&text(&folder), HUMAN).unwrap(),
        refused(&folder, OpenFileError::Directory)
    );
    assert_eq!(
        grants.admit(&text(&fx.home), HUMAN).unwrap(),
        refused(&fx.home, OpenFileError::Directory)
    );
    assert_eq!(grants.confine(&text(&folder)), None);
}

#[test]
fn refuses_a_missing_file_a_dangling_link_and_a_relative_path_outside_the_roots() {
    let fx = Fixture::new();
    let grants = fx.grants();
    symlink(fx.outside.join("gone"), fx.outside.join("dangling")).unwrap();

    for (name, path) in [
        ("missing", text(&fx.outside.join("nope.txt"))),
        ("dangling", text(&fx.outside.join("dangling"))),
        ("relative", "app.log".to_owned()),
    ] {
        let verdict = grants.admit(&path, HUMAN).unwrap();
        assert_eq!(refusal(&verdict), Some(OpenFileError::NotFound), "{name}");
    }
}

#[test]
fn reports_a_relative_path_as_given_in_the_refusal() {
    let fx = Fixture::new();
    assert_eq!(
        fx.grants().admit("app.log", HUMAN).unwrap(),
        OpenFileVerdict::Refused {
            path: "app.log".to_owned(),
            error: OpenFileError::NotFound,
        }
    );
}

#[test]
fn refuses_a_device_and_a_file_the_user_cannot_read() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let device = grants.admit("/dev/null", HUMAN).unwrap();
    assert_eq!(refusal(&device), Some(OpenFileError::NotAFile));

    let secret = fx.outside.join("secret");
    fs::write(&secret, "x").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
    let verdict = grants.admit(&text(&secret), HUMAN).unwrap();
    if rustix::process::getuid().is_root() {
        assert!(matches!(verdict, OpenFileVerdict::Admitted { .. }));
    } else {
        assert_eq!(refusal(&verdict), Some(OpenFileError::Unreadable));
    }
}

#[test]
fn refuses_a_sandboxed_caller_anything_outside_the_roots_and_grants_nothing() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = fx.outside.join("app.log");
    let sandboxed = AdmitOptions {
        sandboxed: true,
        remember: true,
    };

    assert_eq!(
        grants.admit(&text(&file), sandboxed).unwrap(),
        refused(&file, OpenFileError::OutsideSandbox)
    );
    assert_eq!(grants.confine(&text(&file)), None);
    let missing = grants
        .admit(&text(&fx.outside.join("nope")), sandboxed)
        .unwrap();
    assert_eq!(refusal(&missing), Some(OpenFileError::OutsideSandbox));
    assert_eq!(
        grants
            .admit(&text(&fx.home.join("notes.md")), sandboxed)
            .unwrap(),
        admitted(&fx.home.join("notes.md"))
    );
    assert!(fx.store_missing());
}

#[test]
fn stops_reading_a_granted_path_once_it_is_no_longer_that_regular_file() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = fx.outside.join("app.log");
    grants.admit(&text(&file), HUMAN).unwrap();

    fs::rename(&file, fx.outside.join("moved.log")).unwrap();
    symlink(fx.outside.join("other.log"), &file).unwrap();
    assert_eq!(grants.confine(&text(&file)), None);

    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert_eq!(grants.confine(&text(&file)), None);
}

#[test]
fn resolves_a_dot_dot_spelling_to_the_granted_file_and_nothing_else() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = fx.outside.join("app.log");
    grants.admit(&text(&file), HUMAN).unwrap();

    let outside = text(&fx.outside);
    assert_eq!(
        grants.confine(&format!("{outside}/folder/../app.log")),
        Some(text(&file))
    );
    assert_eq!(
        grants.confine(&format!("{outside}/folder/../other.log")),
        None
    );
}

#[test]
fn remembers_a_grant_across_restarts_so_a_restored_tab_still_reads() {
    let fx = Fixture::new();
    let file = fx.outside.join("app.log");
    fx.grants().admit(&text(&file), HUMAN).unwrap();

    assert_eq!(fx.remembered(), [text(&file)]);
    assert_eq!(fx.grants().confine(&text(&file)), Some(text(&file)));
}

#[test]
fn keeps_a_scratch_workspace_grant_in_memory_only() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = fx.outside.join("app.log");
    let scratch = AdmitOptions {
        sandboxed: false,
        remember: false,
    };
    grants.admit(&text(&file), scratch).unwrap();

    assert_eq!(grants.confine(&text(&file)), Some(text(&file)));
    assert!(fx.store_missing());
    assert_eq!(fx.grants().confine(&text(&file)), None);
}

#[test]
fn saves_only_the_newest_grants_past_the_cap_and_keeps_the_rest_for_this_run() {
    let fx = Fixture::new();
    let grants = fx.grants_capped(Some(1));
    let first = fx.outside.join("app.log");
    let second = fx.outside.join("other.log");
    grants.admit(&text(&first), HUMAN).unwrap();
    grants.admit(&text(&second), HUMAN).unwrap();

    assert_eq!(fx.remembered(), [text(&second)]);
    assert_eq!(grants.confine(&text(&first)), Some(text(&first)));
    assert_eq!(fx.grants_capped(Some(1)).confine(&text(&first)), None);
}

#[test]
fn ignores_a_store_that_is_not_a_list_of_absolute_paths() {
    let fx = Fixture::new();
    fs::create_dir(fx.base.join("data")).unwrap();
    let file = text(&fx.outside.join("app.log"));
    fs::write(
        &fx.store,
        json!({ "paths": ["relative.log", 7, file] }).to_string(),
    )
    .unwrap();
    let grants = fx.grants();

    assert_eq!(grants.confine(&file), Some(file.clone()));
    assert_eq!(grants.confine(&text(&fx.base.join("relative.log"))), None);

    fs::write(&fx.store, "\"nope\"").unwrap();
    assert_eq!(fx.grants().confine(&file), None);
}

#[test]
fn saves_the_grants_file_private() {
    let fx = Fixture::new();
    fx.grants()
        .admit(&text(&fx.outside.join("app.log")), HUMAN)
        .unwrap();
    let mode = fs::metadata(&fx.store).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn moves_a_regranted_path_to_the_end_without_listing_it_twice() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let first = text(&fx.outside.join("app.log"));
    let second = text(&fx.outside.join("other.log"));
    grants.admit(&first, HUMAN).unwrap();
    grants.admit(&second, HUMAN).unwrap();
    grants.admit(&first, HUMAN).unwrap();
    assert_eq!(fx.remembered(), [second, first]);
}

#[test]
fn does_not_hold_a_scratch_grant_for_a_path_that_is_already_remembered() {
    let fx = Fixture::new();
    let grants = fx.grants();
    let file = text(&fx.outside.join("app.log"));
    grants.admit(&file, HUMAN).unwrap();
    grants
        .admit(
            &file,
            AdmitOptions {
                sandboxed: false,
                remember: false,
            },
        )
        .unwrap();
    assert_eq!(fx.remembered(), std::slice::from_ref(&file));
    assert_eq!(fx.grants().confine(&file), Some(file));
}

#[test]
fn expands_a_home_path_before_it_checks_the_roots() {
    let fx = Fixture::new();
    let grants = fx.grants();
    assert_eq!(
        grants.admit("~/notes.md", HUMAN).unwrap(),
        admitted(&fx.home.join("notes.md"))
    );
    assert!(fx.store_missing());
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let fx = Fixture::new();
    let marker = |name: &str| {
        fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/fixtures/rust")
                .join(name),
        )
        .unwrap()
        .replace("@ROOT@", &text(&fx.base))
    };
    let first = text(&fx.outside.join("app.log"));
    let second = text(&fx.outside.join("other.log"));

    fx.grants().admit(&first, HUMAN).unwrap();
    assert_eq!(
        fs::read_to_string(&fx.store).unwrap(),
        marker("open-file-grants-before.json")
    );

    fs::write(&fx.store, marker("open-file-grants-before.json")).unwrap();
    let loaded = fx.grants();
    assert_eq!(loaded.confine(&first), Some(first.clone()));
    loaded.admit(&second, HUMAN).unwrap();
    assert_eq!(
        fs::read_to_string(&fx.store).unwrap(),
        marker("open-file-grants-after.json")
    );
}
