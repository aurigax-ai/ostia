#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ostia_base::host::{Host, Platform};
use ostia_base::path_guard::{expand_home, is_inside_path, resolve_safe};

#[test]
fn expands_a_bare_tilde_to_the_home_directory() {
    assert_eq!(expand_home("~", Path::new("/home/u")), Path::new("/home/u"));
}

#[test]
fn expands_tilde_slash_to_a_path_in_home() {
    assert_eq!(
        expand_home("~/notes.txt", Path::new("/home/u")),
        Path::new("/home/u/notes.txt")
    );
}

#[test]
fn leaves_paths_without_a_leading_tilde_untouched() {
    assert_eq!(
        expand_home("/etc/passwd", Path::new("/home/u")),
        Path::new("/etc/passwd")
    );
    assert_eq!(
        expand_home("relative/x", Path::new("/home/u")),
        Path::new("relative/x")
    );
}

#[test]
fn is_inside_path_matches_the_ts_table() {
    let table = [
        ("/", "/", true),
        ("/", "/a", true),
        ("/", "/a/b/c", true),
        ("/a/b", "/a/b", true),
        ("/a/b", "/a/b/", true),
        ("/a/b/", "/a/b", true),
        ("/a/b", "/a/b/c", true),
        ("/a/b/", "/a/b/c", true),
        ("/a/b", "/a/b/c/d.txt", true),
        ("/a/b", "/a/b//c", true),
        ("/a/b", "//a/b/c", true),
        ("/a/b", "/a/b/./c", true),
        ("/a/b", "/a/b/c/..", true),
        ("/a/b", "/a/b/..c", true),
        ("/a/b", "/a/b/...", true),
        ("/a/b", "/a/bc", false),
        ("/a/b", "/a/b-c/d", false),
        ("/a/b", "/a/b.c", false),
        ("/a/b", "/a", false),
        ("/a/b", "/", false),
        ("/a/b", "/a/c", false),
        ("/a/b", "/a/b/..", false),
        ("/a/b", "/a/b/../c", false),
        ("/a/b", "/a/b/../../etc", false),
        ("/a/b", "/a/b/c/../../bc", false),
        ("/a/b", "a/b/c", false),
        ("a/b", "/a/b/c", false),
        ("/a/b", "c", false),
        ("/a/b", "", false),
        ("", "/a/b", false),
    ];
    for (base, path, inside) in table {
        assert_eq!(
            is_inside_path(Path::new(base), Path::new(path)),
            inside,
            "{base} {path}"
        );
    }
}

const ROOT: &str = "/tmp/ostia-guard-root";

fn host() -> Host {
    Host {
        env: BTreeMap::new(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/work/cwd"),
        platform: Platform::Linux,
    }
}

fn safe(input: &str, roots: &[&str]) -> Option<PathBuf> {
    resolve_safe(input, roots, &host())
}

#[test]
fn rejects_a_remote_file_address_which_is_never_a_local_path() {
    assert_eq!(
        safe("remote://abcdef012345/etc/passwd", &["/work/cwd", "/"]),
        None
    );
    assert_eq!(safe("remote://abcdef012345/srv/app", &["/"]), None);
}

#[test]
fn rejects_an_archive_path_which_resolves_against_the_working_folder_as_a_plain_path() {
    let entry = "archive:%2Fetc%2Farchive.zip!/passwd";
    assert_eq!(safe(entry, &["/work/cwd", "/"]), None);
    assert_eq!(safe(entry, &["/"]), None);
}

#[test]
fn rejects_an_absolute_path_outside_every_root_etc_passwd() {
    assert_eq!(safe("/etc/passwd", &[ROOT]), None);
}

#[test]
fn rejects_an_absolute_dot_dot_escape_that_resolves_outside_the_root() {
    assert_eq!(
        safe("/tmp/ostia-guard-root/../../etc/shadow", &[ROOT]),
        None
    );
}

#[test]
fn rejects_a_relative_dot_dot_escape_resolved_against_the_working_folder() {
    assert_eq!(safe("../../etc/passwd", &[ROOT]), None);
}

#[test]
fn rejects_a_sibling_that_merely_shares_a_string_prefix_boundary_bug() {
    let app = "/tmp/ostia-guard-root/app";
    assert_eq!(safe("/tmp/ostia-guard-root/app-secrets/x", &[app]), None);
    assert_eq!(safe(app, &[app]), Some(PathBuf::from(app)));
    assert_eq!(
        safe("/tmp/ostia-guard-root/app/main.ts", &[app]),
        Some(PathBuf::from("/tmp/ostia-guard-root/app/main.ts"))
    );
}

#[test]
fn rejects_a_path_that_is_inside_none_of_several_roots() {
    assert_eq!(
        safe(
            "/etc/hosts",
            &["/tmp/ostia-guard-root/a", "/tmp/ostia-guard-root/b"]
        ),
        None
    );
}

#[test]
fn allows_the_root_itself() {
    assert_eq!(safe(ROOT, &[ROOT]), Some(PathBuf::from(ROOT)));
}

#[test]
fn allows_a_legitimate_subpath_of_the_root() {
    let target = "/tmp/ostia-guard-root/src/a.ts";
    assert_eq!(safe(target, &[ROOT]), Some(PathBuf::from(target)));
}

#[test]
fn expands_tilde_for_an_in_root_path_roots_home() {
    assert_eq!(
        safe("~/notes.txt", &["/home/u"]),
        Some(PathBuf::from("/home/u/notes.txt"))
    );
    assert_eq!(safe("~", &["/home/u"]), Some(PathBuf::from("/home/u")));
}

#[test]
fn expands_tilde_in_a_root_too() {
    assert_eq!(
        safe("/home/u/code/x", &["~/code"]),
        Some(PathBuf::from("/home/u/code/x"))
    );
    assert_eq!(safe("/home/u/other", &["~/code"]), None);
}

#[test]
fn allows_a_path_inside_any_of_several_roots() {
    let target = "/tmp/ostia-guard-root/b/deep/file.txt";
    assert_eq!(
        safe(
            target,
            &["/tmp/ostia-guard-root/a", "/tmp/ostia-guard-root/b"]
        ),
        Some(PathBuf::from(target))
    );
}

#[test]
fn handles_a_trailing_slash_on_the_root_without_off_by_one() {
    assert_eq!(
        safe(ROOT, &["/tmp/ostia-guard-root/"]),
        Some(PathBuf::from(ROOT))
    );
    assert_eq!(
        safe("/tmp/ostia-guard-root/x.txt", &["/tmp/ostia-guard-root/"]),
        Some(PathBuf::from("/tmp/ostia-guard-root/x.txt"))
    );
    assert_eq!(
        safe(
            "/tmp/ostia-guard-root/app-secrets/x",
            &["/tmp/ostia-guard-root/app/"]
        ),
        None
    );
}

#[test]
fn handles_a_trailing_slash_on_the_input_path() {
    assert_eq!(
        safe("/tmp/ostia-guard-root/sub/", &[ROOT]),
        Some(PathBuf::from("/tmp/ostia-guard-root/sub"))
    );
}

#[test]
fn resolves_a_relative_input_against_the_working_folder_of_the_host() {
    assert_eq!(
        safe("src/a.ts", &["/work/cwd"]),
        Some(PathBuf::from("/work/cwd/src/a.ts"))
    );
    assert_eq!(safe("src/a.ts", &["/other"]), None);
}

#[test]
fn allows_nothing_without_roots() {
    assert_eq!(safe("/work/cwd/a", &[]), None);
}
