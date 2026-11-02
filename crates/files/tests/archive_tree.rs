#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::file_browse::{BROWSE_LIMITS, BrowseLimits};
use ostia_contract::files_api::FsEntry;
use ostia_files::archive_tree::{RawEntry, build_tree, segments_of};

fn raw(name: &str, index: usize) -> RawEntry {
    RawEntry {
        name: name.to_owned(),
        index,
        dir: name.ends_with('/'),
        size: 1,
        encrypted: false,
        link: None,
    }
}

fn entry(name: &str, dir: bool) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        dir,
        archive: false,
        link: None,
        encrypted: false,
    }
}

#[test]
fn splits_names_into_literal_segments_escaping_control_characters_and_capping_depth() {
    assert_eq!(
        segments_of("/a//./b/../c", &BROWSE_LIMITS),
        ["a", "b", "..", "c"]
    );
    assert_eq!(segments_of("tab\there", &BROWSE_LIMITS), ["tab\\u0009here"]);
    assert_eq!(
        segments_of("invoice\u{202E}fdp.exe", &BROWSE_LIMITS),
        ["invoice\\u202efdp.exe"]
    );
    assert_eq!(
        segments_of("a\u{200F}b\u{E0041}cd", &BROWSE_LIMITS),
        ["a\\u200fb\\u{e0041}cd"]
    );
    let deep = (0..40)
        .map(|i| format!("d{i}"))
        .collect::<Vec<_>>()
        .join("/");
    let parts = segments_of(&deep, &BROWSE_LIMITS);
    assert_eq!(parts.len(), BROWSE_LIMITS.depth);
    let tail = (0..9)
        .map(|i| format!("d{}", i + 31))
        .collect::<Vec<_>>()
        .join("／");
    assert_eq!(parts.last().unwrap(), &tail);
    assert_eq!(
        segments_of(&"x".repeat(2_000), &BROWSE_LIMITS)[0]
            .chars()
            .count(),
        BROWSE_LIMITS.name_length + 1
    );
}

#[test]
fn makes_folders_from_paths_keeps_duplicate_names_apart_and_addresses_entries_by_index() {
    let tree = build_tree(
        &[
            raw("a/b.txt", 0),
            raw("a/b.txt", 1),
            raw("a", 2),
            raw("a/c/", 3),
            raw("top", 4),
        ],
        &BROWSE_LIMITS,
        false,
    );
    assert_eq!(
        tree.dirs.get(""),
        Some(&vec![
            entry("a", true),
            entry("a (2)", false),
            entry("top", false),
        ])
    );
    assert_eq!(
        tree.dirs.get("a"),
        Some(&vec![
            entry("c", true),
            entry("b.txt", false),
            entry("b.txt (2)", false),
        ])
    );
    assert_eq!(tree.files.get("a/b.txt (2)").map(|r| r.index), Some(1));
    assert_eq!(tree.files.get("a (2)").map(|r| r.index), Some(2));
}

#[test]
fn keeps_at_most_the_entry_limit() {
    let many: Vec<RawEntry> = (0..30).map(|i| raw(&format!("f{i}"), i)).collect();
    let limits = BrowseLimits {
        entries: 10,
        ..BROWSE_LIMITS
    };
    let tree = build_tree(&many, &limits, false);
    assert_eq!(tree.dirs.get("").unwrap().len(), 10);
    assert!(tree.cut);
}

#[test]
fn marks_a_tree_cut_when_the_provider_stopped_early_not_only_past_the_entry_cap() {
    assert!(!build_tree(&[raw("a", 0)], &BROWSE_LIMITS, false).cut);
    assert!(build_tree(&[raw("a", 0)], &BROWSE_LIMITS, true).cut);
}

#[test]
fn numbers_every_repeat_of_a_name_and_keeps_the_first_unnumbered() {
    let tree = build_tree(
        &[raw("a", 0), raw("a", 1), raw("a", 2)],
        &BROWSE_LIMITS,
        false,
    );
    assert_eq!(
        tree.dirs.get(""),
        Some(&vec![
            entry("a", false),
            entry("a (2)", false),
            entry("a (3)", false),
        ])
    );
    assert_eq!(tree.files.get("a (3)").map(|r| r.index), Some(2));
}

#[test]
fn skips_entries_with_no_segments_and_keeps_the_flags_of_the_others() {
    let tree = build_tree(
        &[
            raw("", 0),
            raw("./", 1),
            raw("/", 2),
            RawEntry {
                encrypted: true,
                ..raw("locked.bin", 3)
            },
            RawEntry {
                link: Some("a\tb".to_owned()),
                ..raw("ln", 4)
            },
        ],
        &BROWSE_LIMITS,
        false,
    );
    assert_eq!(
        tree.dirs.get(""),
        Some(&vec![
            FsEntry {
                encrypted: true,
                ..entry("locked.bin", false)
            },
            FsEntry {
                link: Some("a\\u0009b".to_owned()),
                ..entry("ln", false)
            },
        ])
    );
    assert_eq!(tree.files.len(), 2);
    assert_eq!(tree.files.get("ln").unwrap().link.as_deref(), Some("a\tb"));
    assert!(tree.files.get("locked.bin").unwrap().encrypted);
}

#[test]
fn shortens_a_long_name_and_a_long_link_target_with_an_ellipsis() {
    let limits = BrowseLimits {
        name_length: 4,
        ..BROWSE_LIMITS
    };
    assert_eq!(segments_of("abcdefgh/xy", &limits), ["abcd…", "xy"]);
    let tree = build_tree(
        &[RawEntry {
            link: Some("0123456789".to_owned()),
            ..raw("ln", 0)
        }],
        &limits,
        false,
    );
    assert_eq!(tree.dirs.get("").unwrap()[0].link.as_deref(), Some("0123…"));
}

#[test]
fn numbers_twenty_thousand_identical_names_without_rescanning_the_siblings_each_time() {
    let same: Vec<RawEntry> = (0..BROWSE_LIMITS.entries).map(|i| raw("x", i)).collect();
    let started = std::time::Instant::now();
    let tree = build_tree(&same, &BROWSE_LIMITS, false);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let names = tree.dirs.get("").unwrap();
    assert_eq!(names.len(), BROWSE_LIMITS.entries);
    assert_eq!(names[0].name, "x");
    assert_eq!(names[1].name, "x (2)");
    assert_eq!(names[BROWSE_LIMITS.entries - 1].name, "x (20000)");
}
