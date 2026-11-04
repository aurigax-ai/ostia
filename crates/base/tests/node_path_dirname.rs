#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_base::node_path::dirname;

fn of(path: &str) -> String {
    dirname(Path::new(path)).to_string_lossy().into_owned()
}

#[test]
fn matches_node_posix_dirname() {
    assert_eq!(of(""), ".");
    assert_eq!(of("a"), ".");
    assert_eq!(of("/"), "/");
    assert_eq!(of("/a"), "/");
    assert_eq!(of("/a/b"), "/a");
    assert_eq!(of("/a/b/"), "/a");
    assert_eq!(of("/a//b"), "/a/");
    assert_eq!(of("//x"), "//");
    assert_eq!(of("/w/./a.go"), "/w/.");
    assert_eq!(of("a/b"), "a");
}
