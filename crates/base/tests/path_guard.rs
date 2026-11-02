#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_base::path_guard::{expand_home, is_inside_path};

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
