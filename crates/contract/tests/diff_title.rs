#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::diff_title::{change_diff_title, commit_diff_title, files_diff_title};
use ostia_contract::git::ChangeArea;

#[test]
fn names_a_change_like_vs_code_by_the_side_it_shows() {
    assert_eq!(
        change_diff_title("notes.txt", ChangeArea::Unstaged, "M"),
        "notes.txt (Working Tree)"
    );
    assert_eq!(
        change_diff_title("notes.txt", ChangeArea::Staged, "M"),
        "notes.txt (Index)"
    );
    assert_eq!(
        change_diff_title("notes.txt", ChangeArea::Untracked, "?"),
        "notes.txt (Untracked)"
    );
    assert_eq!(
        change_diff_title("notes.txt", ChangeArea::Conflicted, "U"),
        "notes.txt (Working Tree)"
    );
}

#[test]
fn names_a_deleted_file_deleted_whichever_area_it_is_in() {
    assert_eq!(
        change_diff_title("gone.txt", ChangeArea::Staged, "D"),
        "gone.txt (Deleted)"
    );
    assert_eq!(
        change_diff_title("gone.txt", ChangeArea::Unstaged, "D"),
        "gone.txt (Deleted)"
    );
}

#[test]
fn names_a_commit_file_by_its_parent_and_the_commit() {
    assert_eq!(
        commit_diff_title("a.ts", "abcdef0123456789"),
        "a.ts (abcdef0^) ↔ a.ts (abcdef0)"
    );
}

#[test]
fn names_two_files_with_an_arrow() {
    assert_eq!(files_diff_title("a.ts", "b.ts"), "a.ts ↔ b.ts");
}

#[test]
fn keeps_a_whole_short_sha_when_it_has_fewer_than_seven_characters() {
    assert_eq!(commit_diff_title("a.ts", "abc"), "a.ts (abc^) ↔ a.ts (abc)");
    assert_eq!(commit_diff_title("a.ts", ""), "a.ts (^) ↔ a.ts ()");
}

#[test]
fn cuts_a_sha_at_seven_utf16_units_as_slice_does() {
    assert_eq!(
        commit_diff_title("a.ts", "abcdefgh"),
        "a.ts (abcdefg^) ↔ a.ts (abcdefg)"
    );
    assert_eq!(
        commit_diff_title("a.ts", "ééééééééé"),
        "a.ts (ééééééé^) ↔ a.ts (ééééééé)"
    );
}

#[test]
fn only_the_d_code_makes_a_deleted_title() {
    for (code, area, expected) in [
        ("d", ChangeArea::Staged, "x (Index)"),
        ("", ChangeArea::Unstaged, "x (Working Tree)"),
        ("DD", ChangeArea::Conflicted, "x (Working Tree)"),
        ("D", ChangeArea::Untracked, "x (Deleted)"),
        ("D", ChangeArea::Conflicted, "x (Deleted)"),
    ] {
        assert_eq!(
            change_diff_title("x", area, code),
            expected,
            "{code:?} {area:?}"
        );
    }
}
