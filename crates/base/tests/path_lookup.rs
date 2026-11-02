#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ostia_base::path_lookup::find_on_path;

fn executables(files: &[&str]) -> impl Fn(&Path) -> bool {
    let known: HashSet<PathBuf> = files.iter().map(PathBuf::from).collect();
    move |file| known.contains(file)
}

#[test]
fn returns_the_match_in_the_earliest_path_directory() {
    let is_executable = executables(&["/usr/bin/sh", "/bin/sh", "/usr/local/bin/custom"]);
    assert_eq!(
        find_on_path("sh", "/opt/bin:/bin:/usr/bin", &is_executable),
        Some(PathBuf::from("/bin/sh"))
    );
    assert_eq!(
        find_on_path("sh", "/usr/bin:/bin", &is_executable),
        Some(PathBuf::from("/usr/bin/sh"))
    );
    assert_eq!(
        find_on_path("custom", "/opt/bin:/bin:/usr/local/bin", &is_executable),
        Some(PathBuf::from("/usr/local/bin/custom"))
    );
}

#[test]
fn returns_null_when_no_directory_holds_the_program() {
    assert_eq!(
        find_on_path("nope", "/usr/bin:/bin", executables(&["/bin/sh"])),
        None
    );
    assert_eq!(find_on_path("sh", "", executables(&["/bin/sh"])), None);
    assert_eq!(find_on_path("sh", "/usr/bin:/bin", |_: &Path| false), None);
}

#[test]
fn skips_empty_path_entries_instead_of_reading_them_as_the_current_folder() {
    assert_eq!(
        find_on_path("code", ":/bin:", executables(&["/bin/code"])),
        Some(PathBuf::from("/bin/code"))
    );
    assert_eq!(
        find_on_path("code", ":/bin:", executables(&["code", "/bin/code"])),
        Some(PathBuf::from("/bin/code"))
    );
    assert_eq!(find_on_path("code", "::", executables(&["code"])), None);
}

#[test]
fn asks_about_each_candidate_only_by_its_joined_path() {
    let asked = std::cell::RefCell::new(Vec::new());
    let record = |file: &Path| {
        asked.borrow_mut().push(file.to_path_buf());
        false
    };
    find_on_path("code", "/a/:bin:/b//c", record);
    assert_eq!(
        *asked.borrow(),
        vec![
            PathBuf::from("/a/code"),
            PathBuf::from("bin/code"),
            PathBuf::from("/b/c/code"),
        ]
    );
}
